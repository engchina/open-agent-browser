import { createHash, randomUUID } from "node:crypto";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AgentRealtimeEvent, AuditEvent, TaskRun } from "@open-agent-browser/shared";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface RealtimeEventHubOptions {
  isAllowedOrigin?: (origin: string | undefined) => boolean;
}

export class RealtimeEventHub {
  private readonly clients = new Set<Duplex>();

  constructor(private readonly options: RealtimeEventHubOptions = {}) {}

  attach(server: Server): void {
    server.on("upgrade", (request, socket) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (url.pathname !== "/v1/events") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const origin = firstHeader(request.headers.origin);
      if (this.options.isAllowedOrigin && !this.options.isAllowedOrigin(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string" || !isWebSocketUpgrade(request)) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      const accept = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n"
      ].join("\r\n"));

      this.clients.add(socket);
      socket.on("close", () => this.clients.delete(socket));
      socket.on("error", () => this.clients.delete(socket));
      socket.on("data", (chunk) => {
        if (isCloseFrame(chunk)) {
          socket.write(Buffer.from([0x88, 0x00]));
          socket.destroy();
        }
      });

      this.broadcastTo(socket, {
        connectionId: randomUUID(),
        createdAt: new Date().toISOString(),
        kind: "hello"
      });
    });
  }

  publishAudit(event: AuditEvent): void {
    this.broadcast({
      event,
      kind: "audit"
    });
  }

  publishTask(task: TaskRun): void {
    this.broadcast({
      kind: "task",
      task
    });
  }

  private broadcast(event: AgentRealtimeEvent): void {
    const frame = encodeTextFrame(JSON.stringify(event));
    for (const client of this.clients) {
      if (client.destroyed || !client.writable) {
        this.clients.delete(client);
        continue;
      }

      client.write(frame);
    }
  }

  private broadcastTo(client: Duplex, event: AgentRealtimeEvent): void {
    if (!client.destroyed && client.writable) {
      client.write(encodeTextFrame(JSON.stringify(event)));
    }
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isWebSocketUpgrade(request: IncomingMessage): boolean {
  const upgrade = request.headers.upgrade;
  const connection = request.headers.connection;
  const connectionValue = Array.isArray(connection) ? connection.join(",") : connection ?? "";

  return typeof upgrade === "string" &&
    upgrade.toLowerCase() === "websocket" &&
    connectionValue.toLowerCase().includes("upgrade");
}

function isCloseFrame(chunk: Buffer): boolean {
  return chunk.length > 0 && (chunk[0]! & 0x0f) === 0x08;
}

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");

  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }

  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}
