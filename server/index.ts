import { resolve } from "node:path";
import { MAX_CLIENT_MESSAGE_BYTES } from "../src/lib/protocol";
import { verifySession, SESSION_COOKIE_NAME } from "../src/lib/server/access/session";
import { ApiRouter } from "../src/lib/server/http/api-router";
import { readCookie } from "../src/lib/server/http/cookies";
import type { ConnectionIdentity } from "../src/lib/server/room/connection-identity";
import type { GameRoomConnection } from "../src/lib/server/room/game-room";
import { createBackendDescriptor, createRoomMetadata } from "../src/lib/server/room/room-settings";
import { loadRuntimeConfig } from "../src/lib/server/runtime/config";
import { RuntimeServices } from "../src/lib/server/runtime/services";
import { StaticFileServer } from "./static-files";

interface WebSocketData {
  readonly connectionId: string;
  readonly identity: ConnectionIdentity;
}

const config = loadRuntimeConfig();
const roomMetadata = createRoomMetadata(config.publicIceServers);
const descriptor = createBackendDescriptor(roomMetadata);
const services = new RuntimeServices(roomMetadata);
const api = new ApiRouter(config, services, descriptor);
const staticFiles = new StaticFileServer(resolve(import.meta.dir, "../build"));
await staticFiles.assertReady();

const tls =
  config.tlsCertFile !== undefined && config.tlsKeyFile !== undefined
    ? {
        cert: Bun.file(config.tlsCertFile),
        key: Bun.file(config.tlsKeyFile),
      }
    : undefined;
if (tls !== undefined && (!(await tls.cert.exists()) || !(await tls.key.exists()))) {
  throw new Error("TLS_CERT_FILE or TLS_KEY_FILE does not exist");
}

const server = Bun.serve<WebSocketData>({
  hostname: config.host,
  port: config.port,
  ...(tls === undefined ? {} : { tls }),

  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (
      url.pathname === descriptor.websocketPath &&
      request.method === "GET" &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      const token = readCookie(request, SESSION_COOKIE_NAME);
      const session =
        token === undefined ? undefined : await verifySession(token, config.sessionSigningSecret);
      if (session === undefined) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "cache-control": "no-store" },
        });
      }

      const upgraded = bunServer.upgrade(request, {
        data: {
          connectionId: crypto.randomUUID(),
          identity: {
            playerId: session.playerId,
            nickname: session.nickname,
            sessionExpiresAt: session.expiresAt,
          },
        },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    const response = await api.handle(request, clientAddress(request, bunServer));
    return response ?? staticFiles.handle(request);
  },

  websocket: {
    maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
    idleTimeout: 120,
    perMessageDeflate: false,
    backpressureLimit: 1_048_576,
    closeOnBackpressureLimit: true,

    open(socket) {
      const connection: GameRoomConnection = {
        id: socket.data.connectionId,
        identity: socket.data.identity,
        send(message) {
          socket.send(message);
        },
        close(code, reason) {
          socket.close(code, reason);
        },
      };
      services.gameRoom.connect(connection);
    },

    message(socket, message) {
      services.gameRoom.receive(socket.data.connectionId, message);
    },

    close(socket) {
      services.gameRoom.disconnect(socket.data.connectionId);
    },
  },
});

console.log(
  JSON.stringify({
    level: "info",
    event: "server_started",
    url: `${tls === undefined ? "http" : "https"}://${config.host}:${server.port}`,
    runtime: `Bun ${Bun.version}`,
    coturn: config.coturn === undefined ? "disabled" : "enabled",
  }),
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "server_stopping", signal }));
  services.dispose();
  await server.stop(true);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

function clientAddress(request: Request, bunServer: Bun.Server<WebSocketData>): string {
  if (config.trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
    if (forwarded) return forwarded;
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }
  return bunServer.requestIP(request)?.address ?? "unknown";
}
