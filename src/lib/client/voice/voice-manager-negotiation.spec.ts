import { afterEach, describe, expect, it } from "vite-plus/test";
import type { VoiceParticipant, VoiceSignal } from "$lib/protocol";
import type { VoiceManagerEvents } from "./voice-manager";
import { VoiceManager } from "./voice-manager";

interface SignalCall {
  readonly targetPlayerId: string;
  readonly signal: VoiceSignal;
}

class FakeSender {
  track: unknown;
  rejectNextNonNullReplacement = false;

  constructor(track: unknown) {
    this.track = track;
  }

  async replaceTrack(track: unknown): Promise<void> {
    if (track !== null && this.rejectNextNonNullReplacement) {
      this.rejectNextNonNullReplacement = false;
      throw new Error("replacement requires negotiation");
    }
    this.track = track;
  }
}

class FakeTransceiver {
  readonly sender: FakeSender;
  direction: string;

  constructor(track: unknown, direction: string) {
    this.sender = new FakeSender(track);
    this.direction = direction;
  }
}

class FakePeerConnection {
  static instances: Array<FakePeerConnection> = [];

  readonly transceivers: Array<FakeTransceiver> = [];
  connectionState = "connected";
  signalingState = "stable";
  remoteDescription: { readonly type: string; readonly sdp?: string } | null = null;
  onicecandidate: ((event: { readonly candidate: null }) => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  offerCount = 0;
  closed = false;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTransceiver(trackOrKind: unknown, init?: { readonly direction?: string }): FakeTransceiver {
    const track = typeof trackOrKind === "string" ? null : trackOrKind;
    const transceiver = new FakeTransceiver(track, init?.direction ?? "sendrecv");
    this.transceivers.push(transceiver);
    return transceiver;
  }

  async createOffer(): Promise<{ readonly type: "offer"; readonly sdp: string }> {
    this.offerCount += 1;
    return { type: "offer", sdp: `offer-${this.offerCount}` };
  }

  async createAnswer(): Promise<{ readonly type: "answer"; readonly sdp: string }> {
    return { type: "answer", sdp: "answer" };
  }

  async setLocalDescription(description: {
    readonly type: string;
    readonly sdp?: string;
  }): Promise<void> {
    this.signalingState =
      description.type === "offer"
        ? "have-local-offer"
        : description.type === "rollback"
          ? "stable"
          : "stable";
    this.onsignalingstatechange?.();
  }

  async setRemoteDescription(description: {
    readonly type: string;
    readonly sdp?: string;
  }): Promise<void> {
    this.remoteDescription = description;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
    this.onsignalingstatechange?.();
  }

  async addIceCandidate(): Promise<void> {}

  setConfiguration(): void {}

  restartIce(): void {}

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
    this.signalingState = "closed";
  }
}

class FakeAudio {
  autoplay = false;
  volume = 1;
  srcObject: unknown = null;

  async play(): Promise<void> {}

  pause(): void {}
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const originalPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");

function fakeStream() {
  const track = {
    enabled: true,
    stopped: false,
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

function installBrowserFakes(getUserMedia: () => Promise<unknown>): void {
  FakePeerConnection.instances = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia } },
  });
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
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: FakePeerConnection,
  });
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: FakeAudio,
  });
}

function recorder(): {
  readonly events: VoiceManagerEvents;
  readonly signals: Array<SignalCall>;
} {
  const signals: Array<SignalCall> = [];
  return {
    signals,
    events: {
      onPeersChanged: () => {},
      onJoinedChanged: () => {},
      onLocalLevel: () => {},
      onError: () => {},
      sendVoiceSignal: (targetPlayerId, signal) => signals.push({ targetPlayerId, signal }),
      sendVoiceState: () => {},
    },
  };
}

function participant(playerId: string, microphoneEnabled: boolean): VoiceParticipant {
  return {
    playerId,
    nickname: playerId,
    microphoneEnabled,
    muted: !microphoneEnabled,
  };
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor !== undefined) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

afterEach(() => {
  restoreGlobal("navigator", originalNavigator);
  restoreGlobal("fetch", originalFetch);
  restoreGlobal("RTCPeerConnection", originalPeerConnection);
  restoreGlobal("Audio", originalAudio);
});

describe("voice microphone publication", () => {
  it("publishes on the pre-negotiated audio transceiver without a second offer", async () => {
    const media = fakeStream();
    installBrowserFakes(() => Promise.resolve(media.stream));
    const recorded = recorder();
    const manager = new VoiceManager(() => "friend-a", recorded.events, "/turn");

    await manager.startListening();
    manager.updateRoster([participant("friend-b", false)]);
    const peer = FakePeerConnection.instances[0];
    await manager.handleSignal("friend-b", {
      _tag: "ice",
      candidate: null,
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: null,
    });

    expect(peer.offerCount).toBe(1);
    expect(peer.signalingState).toBe("have-local-offer");
    expect(peer.transceivers[0].direction).toBe("sendrecv");
    expect(peer.transceivers[0].sender.track).toBeNull();

    await manager.join();

    expect(peer.transceivers[0].sender.track).toBe(media.track);
    expect(peer.offerCount).toBe(1);
    await manager.handleSignal("friend-b", { _tag: "answer", sdp: "initial-answer" });
    expect(peer.offerCount).toBe(1);
    expect(recorded.signals.filter((call) => call.signal._tag === "offer")).toHaveLength(1);
    manager.dispose();
  });

  it.each([
    ["friend-a", "friend-b"],
    ["friend-b", "friend-a"],
  ])(
    "does not report publication when replaceTrack fails for %s against %s",
    async (selfId, remoteId) => {
      const media = fakeStream();
      installBrowserFakes(() => Promise.resolve(media.stream));
      const recorded = recorder();
      const manager = new VoiceManager(() => selfId, recorded.events, "/turn");

      await manager.startListening();
      manager.updateRoster([participant(remoteId, false)]);
      if (selfId < remoteId) {
        await manager.handleSignal(remoteId, { _tag: "answer", sdp: "initial-answer" });
      } else {
        await manager.handleSignal(remoteId, { _tag: "offer", sdp: "initial-offer" });
      }
      const peer = FakePeerConnection.instances[0];
      expect(peer.transceivers[0].direction).toBe("sendrecv");
      peer.transceivers[0].sender.rejectNextNonNullReplacement = true;

      await manager.join();

      expect(peer.closed).toBe(false);
      expect(FakePeerConnection.instances).toHaveLength(1);
      expect(peer.transceivers[0].sender.track).toBeNull();
      expect(media.track.stopped).toBe(true);
      expect(manager.isJoined).toBe(false);
      manager.dispose();
    },
  );

  it("does not renegotiate when a remote microphone turns on", async () => {
    installBrowserFakes(() => Promise.reject(new Error("microphone not requested")));
    const recorded = recorder();
    const manager = new VoiceManager(() => "friend-a", recorded.events, "/turn");

    await manager.startListening();
    manager.updateRoster([participant("friend-b", false)]);
    await manager.handleSignal("friend-b", { _tag: "answer", sdp: "initial-answer" });
    const peer = FakePeerConnection.instances[0];
    expect(peer.offerCount).toBe(1);
    expect(peer.transceivers[0].direction).toBe("sendrecv");

    manager.updateRoster([participant("friend-b", true)]);

    expect(peer.offerCount).toBe(1);
    manager.dispose();
  });

  it("publishes from the non-offer owner without waiting for another offer", async () => {
    const media = fakeStream();
    installBrowserFakes(() => Promise.resolve(media.stream));
    const recorded = recorder();
    const manager = new VoiceManager(() => "friend-b", recorded.events, "/turn");

    await manager.startListening();
    manager.updateRoster([participant("friend-a", false)]);
    const peer = FakePeerConnection.instances[0];
    expect(peer.offerCount).toBe(0);
    expect(peer.transceivers[0].direction).toBe("sendrecv");
    expect(peer.transceivers[0].sender.track).toBeNull();

    await manager.handleSignal("friend-a", { _tag: "offer", sdp: "initial-offer" });
    await manager.join();

    expect(peer.transceivers[0].sender.track).toBe(media.track);
    expect(peer.offerCount).toBe(0);
    expect(recorded.signals.filter((call) => call.signal._tag === "answer")).toHaveLength(1);
    manager.dispose();
  });

  it("stops publication without changing the negotiated audio direction", async () => {
    const media = fakeStream();
    installBrowserFakes(() => Promise.resolve(media.stream));
    const recorded = recorder();
    const manager = new VoiceManager(() => "friend-a", recorded.events, "/turn");

    await manager.startListening();
    manager.updateRoster([participant("friend-b", false)]);
    await manager.handleSignal("friend-b", { _tag: "answer", sdp: "initial-answer" });
    await manager.join();
    const peer = FakePeerConnection.instances[0];

    manager.leave();

    expect(peer.transceivers[0].direction).toBe("sendrecv");
    expect(peer.transceivers[0].sender.track).toBeNull();
    expect(peer.offerCount).toBe(1);
    manager.dispose();
  });
});
