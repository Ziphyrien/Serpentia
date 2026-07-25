import { afterEach, describe, expect, it } from "vite-plus/test";
import type { VoiceManagerEvents } from "./voice-manager";
import { VoiceManager } from "./voice-manager";

interface VoiceStateCall {
  readonly joined: boolean;
  readonly muted: boolean;
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

function fakeStream() {
  const track = {
    stopped: false,
    enabled: true,
    stop(): void {
      this.stopped = true;
    },
  };
  return {
    track,
    stream: {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    },
  };
}

function eventRecorder(): {
  readonly events: VoiceManagerEvents;
  readonly states: Array<VoiceStateCall>;
  readonly joined: Array<boolean>;
} {
  const states: Array<VoiceStateCall> = [];
  const joined: Array<boolean> = [];
  return {
    states,
    joined,
    events: {
      onPeersChanged: () => {},
      onJoinedChanged: (active) => joined.push(active),
      onLocalLevel: () => {},
      onError: () => {},
      sendVoiceSignal: () => {},
      sendVoiceState: (active, muted) => states.push({ joined: active, muted }),
    },
  };
}

function installNavigator(getUserMedia: () => Promise<unknown>): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia } },
  });
}

function installCredentialFetch(): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () =>
      Promise.resolve(
        Response.json({
          iceServers: [{ urls: ["stun:voice.example.test:3478"] }],
          expiresAt: Date.now() + 60_000,
          refreshAfter: Date.now() + 30_000,
        }),
      ),
  });
}

afterEach(() => {
  restoreGlobal("navigator", originalNavigator);
  restoreGlobal("fetch", originalFetch);
});

function restoreGlobal(
  name: "navigator" | "fetch",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

describe("voice manager lifecycle", () => {
  it("stops a microphone stream that resolves after disposal", async () => {
    const media = fakeStream();
    let resolveStream: ((stream: typeof media.stream) => void) | undefined;
    const streamPromise = new Promise<typeof media.stream>((resolve) => {
      resolveStream = resolve;
    });
    installNavigator(() => streamPromise);
    const recorder = eventRecorder();
    const manager = new VoiceManager(() => "friend-a", recorder.events, "/turn");

    const joining = manager.join();
    manager.dispose();
    resolveStream?.(media.stream);
    await joining;

    expect(media.track.stopped).toBe(true);
    expect(manager.isJoined).toBe(false);
    expect(recorder.states).toEqual([]);
  });

  it("fetches credentials while microphone permission is still pending", async () => {
    const media = fakeStream();
    let resolveStream: ((stream: typeof media.stream) => void) | undefined;
    const streamPromise = new Promise<typeof media.stream>((resolve) => {
      resolveStream = resolve;
    });
    installNavigator(() => streamPromise);
    let credentialRequests = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: () => {
        credentialRequests += 1;
        return Promise.resolve(
          Response.json({
            iceServers: [{ urls: ["stun:voice.example.test:3478"] }],
            expiresAt: Date.now() + 60_000,
            refreshAfter: Date.now() + 30_000,
          }),
        );
      },
    });
    const recorder = eventRecorder();
    const manager = new VoiceManager(() => "friend-a", recorder.events, "/turn");

    const joining = manager.join();
    expect(credentialRequests).toBe(1);
    resolveStream?.(media.stream);
    await joining;

    expect(manager.isJoined).toBe(true);
    manager.dispose();
  });

  it("reuses fresh credentials without retaining the microphone stream", async () => {
    const firstMedia = fakeStream();
    const secondMedia = fakeStream();
    let mediaRequests = 0;
    installNavigator(() => {
      mediaRequests += 1;
      return Promise.resolve(mediaRequests === 1 ? firstMedia.stream : secondMedia.stream);
    });
    let credentialRequests = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: () => {
        credentialRequests += 1;
        return Promise.resolve(
          Response.json({
            iceServers: [{ urls: ["stun:voice.example.test:3478"] }],
            expiresAt: Date.now() + 60_000,
            refreshAfter: Date.now() + 30_000,
          }),
        );
      },
    });
    const recorder = eventRecorder();
    const manager = new VoiceManager(() => "friend-a", recorder.events, "/turn");

    await manager.join();
    manager.leave();
    expect(firstMedia.track.stopped).toBe(true);
    await manager.join();

    expect(mediaRequests).toBe(2);
    expect(credentialRequests).toBe(1);
    expect(manager.isJoined).toBe(true);
    manager.dispose();
    expect(secondMedia.track.stopped).toBe(true);
  });

  it("announces explicit membership and stops tracks on leave", async () => {
    const media = fakeStream();
    installNavigator(() => Promise.resolve(media.stream));
    installCredentialFetch();
    const recorder = eventRecorder();
    const manager = new VoiceManager(() => "friend-a", recorder.events, "/turn");

    await manager.join();
    expect(manager.isJoined).toBe(true);
    expect(recorder.states).toEqual([{ joined: true, muted: false }]);

    manager.leave();
    expect(media.track.stopped).toBe(true);
    expect(manager.isJoined).toBe(false);
    expect(recorder.states).toEqual([
      { joined: true, muted: false },
      { joined: false, muted: true },
    ]);
  });
});
