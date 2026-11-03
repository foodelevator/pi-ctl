import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import {
  MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, Lines, encode, errorText,
  ensureRuntimeDirectory, socketPath, parseRequest, object,
  type Command, type ControlEvent, type Response, type State,
} from "./protocol.ts";

export interface ControlServer {
  id: string;
  publish(event: string, data: unknown): void;
  close(reason: string): Promise<void>;
}

export async function startServer(options: {
  state(id: string): State;
  execute(command: Command): unknown;
  onError(error: Error): void;
}): Promise<ControlServer> {
  const id = randomBytes(6).toString("hex");
  const path = socketPath(ensureRuntimeDirectory(), id);
  const sessionId = options.state(id).sessionId;
  const clients = new Set<Socket>();
  const watchers = new Set<Socket>();
  let closed = false;
  let sequence = 0;

  function write(socket: Socket, value: unknown): void {
    if (socket.destroyed) return;
    try {
      const line = encode(value);
      if (socket.writableLength + Buffer.byteLength(line) > MAX_RESPONSE_BYTES) {
        socket.destroy();
        return;
      }
      socket.write(line);
    } catch {
      // A lost stream is explicit (disconnect), never silently missing an event.
      socket.destroy();
    }
  }

  function publish(event: string, data: unknown): void {
    if (closed || watchers.size === 0) return;
    const record: ControlEvent = {
      type: "event", instanceId: id,
      sessionId,
      sequence: ++sequence, timestamp: new Date().toISOString(), event, data,
    };
    for (const socket of watchers) write(socket, record);
  }

  const server = createServer((socket) => {
    if (closed || clients.size >= 32) { socket.destroy(); return; }
    clients.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { clients.delete(socket); watchers.delete(socket); });
    const lines = new Lines(MAX_REQUEST_BYTES);
    let received = false;
    socket.on("data", (chunk: Buffer) => {
      let requestId: string | null = null;
      try {
        for (const value of lines.push(chunk)) {
          // One request per connection. A watch connection becomes events-only.
          if (received || closed) { socket.destroy(); return; }
          received = true;
          if (object(value) && typeof value.id === "string" && value.id.length <= 128) requestId = value.id;
          const request = parseRequest(value);
          if (request.instanceId !== id) throw new Error("Instance replaced; run pi --ctl -- list again");
          const data = request.command === "watch" ? options.state(id) : options.execute(request);
          const response: Response = { type: "response", id: request.id, ok: true, data };
          const line = encode(response);
          if (request.command === "watch") {
            socket.write(line);
            socket.setTimeout(0);
            watchers.add(socket);
          } else {
            socket.end(line);
          }
        }
      } catch (error) {
        socket.end(encode({ type: "response", id: requestId, ok: false, error: errorText(error) }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  server.on("error", options.onError);
  try { chmodSync(path, 0o600); }
  catch (error) { server.close(); throw error; }

  return {
    id,
    publish,
    async close(reason) {
      if (closed) return;
      publish("session_closed", { reason });
      closed = true;
      // Allow the closing event to flush, but never let a slow reader block reload.
      for (const socket of clients) {
        socket.end();
        const timer = setTimeout(() => socket.destroy(), 100).unref();
        socket.once("close", () => clearTimeout(timer));
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
