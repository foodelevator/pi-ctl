import { createWriteStream } from "node:fs";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { discover, exchange, request, selectTarget, waitForResult } from "./client.ts";
import { MAX_REQUEST_BYTES, errorText, object, type Command, type State } from "./protocol.ts";

const HELP = `Usage:
  pi --ctl -- list [--json]
  pi --ctl -- <target> state [--json]
  pi --ctl -- <target> send [--follow-up] <message | -> [--json]
  pi --ctl -- <target> messages [--last 10] [--json]
  pi --ctl -- <target> watch [--json]
  pi --ctl -- <target> wait [--json]
  pi --ctl -- <target> abort [--json]

Targets: control ID, session ID, or name; unambiguous prefixes accepted.
Use - to read a multiline message from stdin. Use -- before dash-prefixed text.
send starts a run if idle, otherwise steers; --follow-up queues after current work.
An acknowledgement means submitted to Pi, not delivered or completed.
watch starts with a state snapshot, then live events; no replay or reconnection.
wait waits for settlement and prints the last answer (immediately if already idle).
`;

function safe(text: string, multiline = false): string {
  return stripVTControlCharacters(text).replace(multiline ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g, " ");
}

function summary(state: State): string[] {
  return [state.id, String(state.pid), state.waitingForUser ? "waiting" : state.idle ? "idle" : "busy",
    state.sessionName ?? "(unnamed)", state.cwd, state.sessionId].map((value) => safe(value));
}

function messageText(value: unknown): string {
  if (!object(value)) return JSON.stringify(value);
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content.map((block: unknown) => {
      if (!object(block)) return JSON.stringify(block);
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "thinking" && typeof block.thinking === "string") return `[thinking] ${block.thinking}`;
      if (block.type === "image") return "[image]";
      return JSON.stringify(block);
    }).join("\n");
  }
  return JSON.stringify(value);
}

async function stdinMessage(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("Message exceeds 1 MiB request limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Run inside the extension factory, before Pi starts a session or reads stdin. */
export async function runControl(argv: string[]): Promise<number> {
  // Pi redirects process.stdout.write to stderr in non-TUI mode. Own fd 1
  // directly, and await every write so exiting cannot truncate piped results.
  const stdout = createWriteStream("", { fd: 1, autoClose: false });
  stdout.on("error", () => {}); // The write callback reports errors to the caller.
  async function output(value: unknown): Promise<void> {
    const line = typeof value === "string" ? value : JSON.stringify(value);
    await new Promise<void>((resolve, reject) => {
      stdout.write(line + "\n", (error) => error ? reject(error) : resolve());
    });
  }
  let json = false;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" },
        "follow-up": { type: "boolean" }, last: { type: "string" } },
    });
    json = values.json ?? false;
    if (values.help || positionals.length === 0) {
      await output(HELP);
    } else if (positionals[0] === "list") {
      if (positionals.length !== 1 || values["follow-up"] || values.last !== undefined) throw new Error("Usage: pi --ctl -- list [--json]");
      const states = await discover();
      if (json) await output(states);
      else if (states.length === 0) await output("No live sessions.");
      else {
        const headers = ["ID", "PID", "STATUS", "NAME", "CWD", "SESSION"];
        const rows = [headers, ...states.map(summary)];
        const widths = headers.map((_, index) => Math.max(...rows.map((row) => row[index]!.length)));
        for (const row of rows) {
          await output(row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join("  "));
        }
      }
    } else {
      const [target, name, ...args] = positionals;
      if (!target || !name) throw new Error(HELP);
      if (values["follow-up"] && name !== "send") throw new Error("--follow-up is only valid for send");
      if (values.last !== undefined && name !== "messages") throw new Error("--last is only valid for messages");
      if (name !== "send" && args.length) throw new Error(`Unexpected arguments for ${name}`);
      let command: Command;
      switch (name) {
        case "state": case "watch": case "abort": command = { command: name }; break;
        case "wait": command = { command: "watch" }; break;
        case "messages": {
          const last = values.last === undefined ? 10 : Number(values.last);
          if (!Number.isInteger(last) || last < 1 || last > 1000) throw new Error("--last must be an integer from 1 to 1000");
          command = { command: "messages", last };
          break;
        }
        case "send": {
          const message = args.length === 1 && args[0] === "-" ? await stdinMessage() : args.join(" ");
          if (!message.trim()) throw new Error("send requires a message, or - to read stdin");
          command = { command: "send", message, delivery: values["follow-up"] ? "followUp" : "steer" };
          break;
        }
        default: throw new Error(`Unknown command: ${name}\n${HELP}`);
      }
      const state = selectTarget(await discover(), target);
      if (name === "wait") {
        const result = await waitForResult(state.id);
        await output(json ? result : result.text);
      } else if (command.command === "watch") {
        for await (const record of exchange(state.id, command)) {
          if (json) await output(record);
          else if (record.type === "response" && record.ok) await output(`Watching ${summary(record.data as State).join("  ")}`);
          else if (record.type === "event") await output(safe(`${record.timestamp} ${record.event} ${JSON.stringify(record.data)}`));
        }
      } else {
        const data = await request(state.id, command);
        if (json) await output(data);
        else if (command.command === "messages" && object(data) && Array.isArray(data.messages)) {
          for (const item of data.messages) {
            if (object(item) && object(item.message)) {
              await output(safe(`[${String(item.message.role)} · ${String(item.entryId)}]\n${messageText(item.message)}`, true));
            }
          }
        } else if (command.command === "state") await output(safe(JSON.stringify(data, null, 2), true));
      }
    }
    return 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") return 0;
    const message = errorText(error);
    await new Promise<void>((resolve) => {
      process.stderr.write((json ? JSON.stringify({ error: message }) : `pi --ctl: ${safe(message, true)}`) + "\n", () => resolve());
    });
    return 1;
  }
}
