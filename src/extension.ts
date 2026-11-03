import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startServer, type ControlServer } from "./server.ts";
import type { Command, State } from "./protocol.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerFlag("ctl", {
    description: "Control a running Pi session: pi --ctl -- <target> <command>",
    type: "boolean",
    default: false,
  });

  // getFlag() only exposes defaults during factory loading. Inspect argv here
  // to finish before Pi starts a session, consumes stdin, or opens the TUI.
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const flag = argv.indexOf("--ctl");
  if (flag !== -1 && (separator === -1 || flag < separator)) {
    try {
      const { runControl } = await import("./cli.ts");
      if (flag !== argv.length - 1 && separator !== flag + 1) {
        await new Promise<void>((resolve) => {
          process.stderr.write("Usage: pi --ctl -- <target> <command>\n", () => resolve());
        });
        process.exit(1);
      }
      process.exit(await runControl(argv.slice(flag + (separator === flag + 1 ? 2 : 1))));
    } catch (error) {
      // Factory errors normally let Pi continue. Control invocations must not
      // fall through and submit their arguments as an agent prompt.
      await new Promise<void>((resolve) => {
        process.stderr.write(`pi --ctl: ${String(error)}\n`, () => resolve());
      });
      process.exit(1);
    }
  }

  let server: ControlServer | undefined;
  let context: ExtensionContext | undefined;
  let waitingForUser = false;

  function state(id: string): State {
    if (!context) throw new Error("Session is no longer available");
    const ctx = context;
    return {
      id, pid: process.pid,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionName: ctx.sessionManager.getSessionName() ?? null,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      cwd: ctx.cwd,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
      thinkingLevel: ctx.thinkingLevel ?? null,
      idle: ctx.isIdle(), hasPendingMessages: ctx.hasPendingMessages(),
      waitingForUser, contextUsage: ctx.getContextUsage() ?? null,
    };
  }

  function execute(command: Command): unknown {
    if (!context || !server) throw new Error("Session is no longer available");
    switch (command.command) {
      case "state": return state(server.id);
      case "send":
        pi.sendUserMessage(command.message, {
          deliverAs: command.delivery,
          expandPromptTemplates: false,
        });
        // Pi's public API is void: input hooks and asynchronous errors happen later.
        return { status: "submitted", delivery: command.delivery };
      case "abort":
        context.abort();
        return { status: "abort_requested" };
      case "messages": {
        const messages = context.sessionManager.getBranch().flatMap((entry) => {
          if (entry.type === "message") {
            return [{ entryId: entry.id, timestamp: entry.timestamp, message: entry.message }];
          }
          if (entry.type === "custom_message") {
            return [{ entryId: entry.id, timestamp: entry.timestamp, message: {
              role: "custom" as const, customType: entry.customType,
              content: entry.content, display: entry.display, details: entry.details,
              timestamp: Date.parse(entry.timestamp),
            } }];
          }
          return [];
        });
        return {
          leafId: context.sessionManager.getLeafId(), total: messages.length,
          messages: messages.slice(-command.last),
        };
      }
      case "watch": throw new Error("watch is handled by the transport");
    }
  }

  function publish(event: string, data: unknown, ctx: ExtensionContext): void {
    if (!server) return;
    context = ctx;
    server.publish(event, data);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    waitingForUser = false;
    server = await startServer({
      state, execute,
      onError: (error) => ctx.ui.notify(`pi-ctl: ${error.message}`, "error"),
    });
  });
  pi.on("session_shutdown", async (event) => {
    try { await server?.close(event.reason); }
    finally { server = undefined; context = undefined; waitingForUser = false; }
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    waitingForUser = true;
    publish(event.type, { kind: event.kind, title: event.title }, ctx);
  });
  pi.on("ui_prompt_end", (event, ctx) => {
    waitingForUser = false;
    publish(event.type, { kind: event.kind }, ctx);
  });
  pi.on("agent_start", (event, ctx) => publish(event.type, {}, ctx));
  pi.on("agent_end", (event, ctx) => publish(event.type, {}, ctx));
  pi.on("agent_settled", (event, ctx) => publish(event.type, { aborted: event.aborted }, ctx));
  pi.on("turn_start", (event, ctx) => publish(event.type, { turnIndex: event.turnIndex }, ctx));
  pi.on("turn_end", (event, ctx) => publish(event.type, { turnIndex: event.turnIndex, outcome: event.outcome }, ctx));
  pi.on("message_end", (event, ctx) => publish(event.type, { message: event.message }, ctx));
  pi.on("session_info_changed", (event, ctx) => publish(event.type, { name: event.name ?? null }, ctx));
  pi.on("session_tree", (event, ctx) => publish(event.type, { leafId: event.newLeafId }, ctx));
  pi.on("session_compact", (event, ctx) => publish(event.type, { reason: event.reason }, ctx));
  pi.on("session_compact_failed", (event, ctx) => publish(event.type, { reason: event.reason, error: event.errorMessage }, ctx));
  pi.on("model_select", (event, ctx) => publish(event.type, { provider: event.model.provider, id: event.model.id }, ctx));
  pi.on("thinking_level_select", (event, ctx) => publish(event.type, { level: event.level }, ctx));
}
