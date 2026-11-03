import { lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const ID_PATTERN = /^[a-f0-9]{12}$/;

export interface State {
  id: string;
  pid: number;
  sessionId: string;
  sessionName: string | null;
  sessionFile: string | null;
  cwd: string;
  model: { provider: string; id: string } | null;
  thinkingLevel: string | null;
  idle: boolean;
  hasPendingMessages: boolean;
  waitingForUser: boolean;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
}

export type Command =
  | { command: "state" | "watch" | "abort" }
  | { command: "send"; message: string; delivery: "steer" | "followUp" }
  | { command: "messages"; last: number };
export type Request = Command & { id: string; instanceId: string };
export type Response = { type: "response"; id: string | null } & (
  | { ok: true; data: unknown }
  | { ok: false; error: string }
);
export interface ControlEvent {
  type: "event";
  instanceId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  event: string;
  data: unknown;
}
export type Record = Response | ControlEvent;

export function object(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRequest(value: unknown): Request {
  if (!object(value) || typeof value.id !== "string" ||
      value.id.length === 0 || value.id.length > 128 ||
      typeof value.instanceId !== "string" || !ID_PATTERN.test(value.instanceId)) {
    throw new Error("Expected a request id (1–128 characters) and an instanceId");
  }
  switch (value.command) {
    case "state": case "watch": case "abort": break;
    case "send":
      if (typeof value.message !== "string" || !value.message.trim() ||
          (value.delivery !== "steer" && value.delivery !== "followUp")) {
        throw new Error("send requires non-empty message and delivery: steer | followUp");
      }
      break;
    case "messages":
      if (!Number.isInteger(value.last) || (value.last as number) < 1 || (value.last as number) > 1000) {
        throw new Error("messages.last must be an integer from 1 to 1000");
      }
      break;
    default: throw new Error("Unknown command");
  }
  return value as Request;
}

/** LF-only framing, bounded in bytes even when a client never finishes a line. */
export class Lines {
  #parts: Buffer[] = [];
  #bytes = 0;
  #limit: number;

  constructor(limit: number) { this.#limit = limit; }

  *push(chunk: Buffer): Generator<unknown> {
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start);
      const end = lf === -1 ? chunk.length : lf;
      const part = chunk.subarray(start, end);
      this.#bytes += part.length;
      if (this.#bytes > this.#limit) throw new Error("Protocol record exceeds byte limit");
      this.#parts.push(part);
      if (lf === -1) return;
      const line = Buffer.concat(this.#parts, this.#bytes).toString("utf8");
      this.#parts = [];
      this.#bytes = 0;
      yield JSON.parse(line);
      start = lf + 1;
    }
  }
}

export function encode(value: unknown, limit = MAX_RESPONSE_BYTES): string {
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line) > limit) throw new Error("Protocol record exceeds byte limit");
  return line;
}

export function runtimeDirectory(): string {
  if (process.getuid === undefined) throw new Error("pi-ctl supports macOS and Linux");
  return resolve(process.env.PI_CTL_RUNTIME_DIR ?? join(tmpdir(), `pi-ctl-${process.getuid()}`));
}

export function checkPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Refusing runtime directory not owned by you with mode 0700: ${path}`);
  }
}

export function ensureRuntimeDirectory(): string {
  const path = runtimeDirectory();
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  checkPrivateDirectory(path);
  return path;
}

export function socketPath(directory: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid instance ID");
  const path = join(directory, `${id}.sock`);
  if (Buffer.byteLength(path) > 100) {
    throw new Error("Socket path too long; set PI_CTL_RUNTIME_DIR to a shorter private directory in both terminals");
  }
  return path;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
