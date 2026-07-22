import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { encodeNicknameHeader } from "../connection-identity";

interface TaggedPayload {
  readonly _tag: string;
  readonly [key: string]: unknown;
}

interface ConnectedClient {
  readonly socket: WebSocket;
  readonly welcome: TaggedPayload;
}

afterEach(async () => {
  await abortAllDurableObjects();
});

describe("GameRoom Durable Object WebSocket", () => {
  it("upgrades authenticated players and publishes authoritative snapshots", async () => {
    const client = await connect("connection-a", "friend-a", "Alpha");
    expect(client.welcome._tag).toBe("welcome");
    expect(client.welcome.selfPlayerId).toBe("friend-a");
    expect(client.welcome.resumed).toBe(false);

    const snapshot = waitForTag(client.socket, "snapshot");
    client.socket.send(
      JSON.stringify({
        v: 1,
        _tag: "input",
        sequence: 1,
        clientTick: 0,
        angle: 0.5,
        boosting: true,
      }),
    );
    const message = await snapshot;
    expect(message._tag).toBe("snapshot");
    expect(message.snapshot).toBeDefined();
    client.socket.close(1000, "test complete");
  });

  it("relays P2P voice signaling only between authenticated room members", async () => {
    const alpha = await connect("connection-a", "friend-a", "Alpha");
    const beta = await connect("connection-b", "friend-b", "Beta");
    expect(alpha.welcome.selfPlayerId).toBe("friend-a");
    expect(beta.welcome.selfPlayerId).toBe("friend-b");

    const forwarded = waitForTag(beta.socket, "voice-signal");
    alpha.socket.send(
      JSON.stringify({
        v: 1,
        _tag: "voice-signal",
        targetPlayerId: "friend-b",
        signal: { _tag: "offer", sdp: "v=0\r\n" },
      }),
    );
    const signal = await forwarded;
    expect(signal.fromPlayerId).toBe("friend-a");
    expect(signal.signal).toEqual({ _tag: "offer", sdp: "v=0\r\n" });
    alpha.socket.close(1000, "test complete");
    beta.socket.close(1000, "test complete");
  });

  it("rejects duplicate normalized nicknames at the room boundary", async () => {
    const alpha = await connect("connection-a", "friend-a", "Alpha");
    const duplicateResponse = await upgrade("connection-b", "friend-b", "ＡLPHA");
    const duplicateSocket = requireSocket(duplicateResponse);
    duplicateSocket.accept();
    const error = await waitForTag(duplicateSocket, "error");
    expect(error.code).toBe("NICKNAME_IN_USE");
    alpha.socket.close(1000, "test complete");
    duplicateSocket.close(1000, "test complete");
  });
});

async function connect(
  connectionId: string,
  playerId: string,
  nickname: string,
): Promise<ConnectedClient> {
  const response = await upgrade(connectionId, playerId, nickname);
  expect(response.status).toBe(101);
  const socket = requireSocket(response);
  socket.accept();
  const welcome = await waitForTag(socket, "welcome");
  return { socket, welcome };
}

function upgrade(connectionId: string, playerId: string, nickname: string): Promise<Response> {
  return env.GAME_ROOM.getByName("friends").fetch(
    new Request(`https://room.test/?_pk=${connectionId}`, {
      headers: {
        upgrade: "websocket",
        "x-serpentia-player-id": playerId,
        "x-serpentia-nickname": encodeNicknameHeader(nickname),
        "x-serpentia-session-expires-at": String(Date.now() + 60_000),
      },
    }),
  );
}

function requireSocket(response: Response): WebSocket {
  const socket = response.webSocket;
  if (socket === null) throw new Error("WebSocket upgrade did not return a socket");
  return socket;
}

function waitForTag(socket: WebSocket, tag: string): Promise<TaggedPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`Timed out waiting for ${tag}`));
    }, 2_000);

    function onMessage(event: MessageEvent): void {
      if (typeof event.data !== "string") return;
      const payload = parseTaggedPayload(event.data);
      if (payload === undefined || payload._tag !== tag) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(payload);
    }

    socket.addEventListener("message", onMessage);
  });
}

function parseTaggedPayload(text: string): TaggedPayload | undefined {
  try {
    const payload: unknown = JSON.parse(text);
    if (typeof payload !== "object" || payload === null || !("_tag" in payload)) {
      return undefined;
    }
    const tag = payload._tag;
    return typeof tag === "string" ? { ...payload, _tag: tag } : undefined;
  } catch {
    return undefined;
  }
}
