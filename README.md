# pi-ctl

Control a running interactive Pi session from another terminal using a local Unix socket.

## Installation

From the checkout directory, register the Pi package:

```sh
pi install "$PWD"
```

## Commands

Use `pi --ctl -- …`. The first `--` keeps control arguments separate from Pi's own options. The command runs during extension loading and exits without starting an agent session or opening the TUI. No separately linked binary is needed.

```sh
pi --ctl -- list
pi --ctl -- <target> state
pi --ctl -- <target> send "Check the failing tests"
pi --ctl -- <target> send --follow-up "Then summarize"
printf 'First line\nSecond line\n' | pi --ctl -- <target> send -
pi --ctl -- <target> messages --last 10
pi --ctl -- <target> watch
pi --ctl -- <target> wait
pi --ctl -- <target> abort
```

Targets accept a control ID, session ID, name, or unambiguous prefix. Exact control IDs take precedence. Each running instance has its own control ID; ambiguous targets produce an error.

Add `--json` for machine-readable output (`watch` produces JSONL). Errors go to stderr with exit status 1. Use `--` before dash-prefixed message text.

- **send:** starts a run when idle; steers after the current assistant turn and tool calls when busy. `--follow-up` queues work after the current run. Messages are ordinary text processed through Pi's input hooks.
- **Acknowledgement:** `status: "submitted"` confirms the call to Pi's fire-and-forget API. Check Pi or watch events for the outcome. After a lost connection, inspect history before resending.
- **state:** session identity, PID, directory, model, thinking level, idle/busy status, pending-message flag, extension-dialog waiting flag, and context usage.
- **messages:** finalized message entries on the active branch, including system and tool results. Returns the latest 10 by default, up to 1000, in chronological order with entry IDs and timestamps. For oversized responses, request fewer messages or inspect the session file.
- **watch:** starts with a state snapshot, then emits one `message_end` per user, assistant, or tool-result message, alongside lifecycle and session events. Codemode produces its final tool-result message. Use `agent_settled` for completion and `messages` for persisted results. Reconnect explicitly after disconnection.
- **wait:** waits for `agent_settled`, prints the latest assistant answer's text, and exits. If already idle with no queued work or dialog, returns the latest answer immediately. `--json` returns `{ sessionId, entryId, text }`. Errors, aborts, missing text answers, and disconnections exit nonzero. A length-limited answer is returned as-is. This waits for agent settlement, not background-process cleanup, and does not independently verify task success. It uses `watch`, `messages`, and `state`; no new wire command is required. Keep the session dedicated to the task while waiting; results are not correlated to a particular `send`. Stopping the waiter leaves Pi running.
- **abort:** requests cancellation. Check state or watch settlement to confirm completion.

Reloading, switching, forking, or creating a session closes existing connections and assigns a new control ID. Run `list` again to select the current instance.

## Transport and security

Sockets live under `$TMPDIR/pi-ctl-<uid>/` (Node's OS temporary directory). Override with the same `PI_CTL_RUNTIME_DIR` in Pi and the client. Choose a short absolute path with an existing parent; socket paths are limited to 100 bytes.

The runtime directory is owner-only (0700), and sockets are 0600. Discovery probes live sockets and skips unresponsive endpoints. Graceful shutdown removes its socket; confirmed crash leftovers can be removed manually.

Requests are limited to 1 MiB; responses, events, and per-client pending output to 8 MiB. The server supports 32 connections and disconnects slow watchers. Initial requests have a 5-second deadline; discovery probes have a 750 ms deadline.

### Protocol

One request per connection, encoded as UTF-8 JSON followed by LF. A `watch` response is followed by live events.

```json
{"id":"request-1","instanceId":"012345abcdef","command":"state"}
```

Commands are `state`, `watch`, `abort`, `send` (with `message` and `delivery: "steer" | "followUp"`), and `messages` (with `last: 1–1000`). Responses echo the request ID and carry either `ok: true, data` or `ok: false, error`.

See `src/protocol.ts` for record types and validation.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
pi -e ./src/extension.ts --ctl -- --help
```

TypeScript checks strict typing, erasable syntax, and explicit type imports. Pi loads the TypeScript extension directly.

- `src/cli.ts`: control command parsing and output.
- `src/client.ts`: discovery, targeting, requests, and watching.
- `src/extension.ts`: Pi API adapter and event subscriptions.
- `src/server.ts`: socket server and cleanup.
- `src/protocol.ts`: shared types, framing, validation, and paths.
