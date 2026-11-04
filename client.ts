import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import {
  ID_PATTERN, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, Lines, encode, object,
  runtimeDirectory, checkPrivateDirectory, socketPath,
  type Command, type Record, type Request, type State,
} from "./protocol.ts";

export async function* exchange(
  instanceId: string,
  command: Command,
  timeoutMs = 5000,
): AsyncGenerator<Record> {
  const directory = runtimeDirectory();
  checkPrivateDirectory(directory);
  const path = socketPath(directory, instanceId);
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("Refusing socket with unsafe ownership, type, or permissions");
  }
  const request: Request = { ...command, id: randomUUID(), instanceId };
  const line = encode(request, MAX_REQUEST_BYTES);
  const socket = createConnection(path);
  const timer = setTimeout(() => socket.destroy(new Error("Timed out waiting for pi-ctl response")), timeoutMs);
  // Attach before any await; the async iterator also propagates this error.
  socket.on("error", () => {});
  let acknowledged = false;
  socket.once("connect", () => socket.write(line));
  try {
    const lines = new Lines(MAX_RESPONSE_BYTES);
    for await (const chunk of socket) {
      for (const value of lines.push(chunk as Buffer)) {
        if (!object(value)) throw new Error("Invalid protocol response");
        if (!acknowledged) {
          if (value.type !== "response" || value.id !== request.id || typeof value.ok !== "boolean") {
            throw new Error("Mismatched protocol response");
          }
          if (!value.ok) throw new Error(typeof value.error === "string" ? value.error : "Request failed");
          acknowledged = true;
          clearTimeout(timer);
          yield value as Record;
          if (command.command !== "watch") return;
        } else {
          if (value.type !== "event" || value.instanceId !== instanceId || typeof value.event !== "string") {
            throw new Error("Invalid watch event");
          }
          yield value as Record;
          if (value.event === "session_closed") return;
        }
      }
    }
    throw new Error(acknowledged ? "Session disconnected; run pi --ctl -- list again" : "Disconnected before acknowledgement; delivery is unknown");
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

export async function request(instanceId: string, command: Command, timeoutMs = 5000): Promise<unknown> {
  for await (const record of exchange(instanceId, command, timeoutMs)) {
    if (record.type === "response" && record.ok) return record.data;
  }
  throw new Error("Missing response");
}

export interface WaitResult {
  sessionId: string;
  entryId: string;
  text: string;
}

/** Subscribe before checking idle state so settlement cannot fall between them. */
export async function waitForResult(instanceId: string): Promise<WaitResult> {
  for await (const record of exchange(instanceId, { command: "watch" })) {
    let sessionId: string;
    if (record.type === "response" && record.ok) {
      const state = record.data as State;
      if (!state.idle || state.hasPendingMessages || state.waitingForUser) continue;
      sessionId = state.sessionId;
    } else if (record.type === "event" && record.event === "agent_settled") {
      if (object(record.data) && record.data.aborted) throw new Error("Agent was aborted");
      sessionId = record.sessionId;
    } else if (record.type === "event" && record.event === "session_closed") {
      throw new Error("Session closed before a result was available");
    } else {
      continue;
    }

    let entries: unknown[];
    for (let last = 10; ; last = Math.min(last * 2, 1000)) {
      const data = await request(instanceId, { command: "messages", last });
      if (!object(data) || !Array.isArray(data.messages)) throw new Error("Invalid messages response");
      entries = data.messages;
      if (entries.some((entry) => object(entry) && object(entry.message) &&
          (entry.message.role === "assistant" || entry.message.role === "user")) ||
          entries.length < last || last === 1000) break;
    }
    // Work may have started again while the snapshot was being fetched.
    const current = await request(instanceId, { command: "state" }) as State;
    if (!current.idle || current.hasPendingMessages || current.waitingForUser) continue;
    for (const entry of [...entries].reverse()) {
      if (!object(entry) || !object(entry.message)) continue;
      const message = entry.message;
      if (message.role === "user") break;
      if (message.role !== "assistant") continue;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(typeof message.errorMessage === "string" ? message.errorMessage : `Agent ${message.stopReason}`);
      }
      if (message.stopReason !== "stop" && message.stopReason !== "length") {
        throw new Error("Last assistant message is not a completed answer");
      }
      const text = Array.isArray(message.content) ? message.content
        .filter((block: unknown) => object(block) && block.type === "text" && typeof block.text === "string")
        .map((block: { text: string }) => block.text).join("\n") : "";
      if (!text.trim()) throw new Error("Last assistant answer has no text");
      return { sessionId, entryId: String(entry.entryId), text };
    }
    throw new Error("No assistant answer available");
  }
  throw new Error("Session disconnected before a result was available");
}

export async function discover(): Promise<State[]> {
  const directory = runtimeDirectory();
  let names: string[];
  try {
    checkPrivateDirectory(directory);
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids = names.filter((name) => name.endsWith(".sock") && ID_PATTERN.test(name.slice(0, -5)))
    .map((name) => name.slice(0, -5));
  const states: State[] = [];
  // Bounded probing; stale/unresponsive sockets are ignored, never unlinked blindly.
  for (let start = 0; start < ids.length; start += 8) {
    const results = await Promise.allSettled(ids.slice(start, start + 8).map(async (id) => {
      const value = await request(id, { command: "state" }, 750);
      if (!object(value) || value.id !== id || typeof value.sessionId !== "string" ||
          typeof value.cwd !== "string" || typeof value.pid !== "number" || typeof value.idle !== "boolean" ||
          !(value.sessionName === null || typeof value.sessionName === "string")) {
        throw new Error("Invalid discovery response");
      }
      return value as unknown as State;
    }));
    for (const result of results) if (result.status === "fulfilled") states.push(result.value);
  }
  return states.sort((a, b) => a.pid - b.pid || a.id.localeCompare(b.id));
}

export function selectTarget(states: State[], target: string): State {
  const exact = states.find((state) => state.id === target);
  if (exact) return exact;
  const matches = states.filter((state) => state.id.startsWith(target) ||
    state.sessionId.startsWith(target) || state.sessionName?.startsWith(target));
  if (matches.length === 0) throw new Error(`No live session matches ${JSON.stringify(target)}; run pi --ctl -- list`);
  if (matches.length > 1) throw new Error(`Ambiguous target ${JSON.stringify(target)}: ${matches.map((state) => state.id).join(", ")}`);
  return matches[0]!;
}
