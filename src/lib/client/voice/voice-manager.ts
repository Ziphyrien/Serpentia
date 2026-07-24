import { Schema } from "effect";
import {
  TurnCredentialsResponse,
  type IceServer,
  type PlayerId,
  type VoiceParticipant,
  type VoiceSignal,
} from "$lib/protocol";

interface AudioMeter {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
}

interface PeerEntry {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  nickname: string;
  makingOffer: boolean;
  signaling: Promise<void>;
  pendingIce: Array<RTCIceCandidateInit | null>;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
}

type VoiceLifecycle = "idle" | "joining" | "joined" | "disposed";

export interface VoicePeerView {
  playerId: PlayerId;
  nickname: string;
  muted: boolean;
  speaking: boolean;
  volume: number;
  connected: boolean;
}

export interface VoiceManagerEvents {
  onPeersChanged(peers: Array<VoicePeerView>): void;
  onJoinedChanged(joined: boolean, muted: boolean): void;
  onLocalLevel(level: number): void;
  onError(message: string): void;
  sendVoiceSignal(targetPlayerId: PlayerId, signal: VoiceSignal): void;
  sendVoiceState(joined: boolean, muted: boolean): void;
}

const decodeTurnCredentials = Schema.decodeUnknownSync(TurnCredentialsResponse);
const CREDENTIAL_RETRY_MS = 30_000;
const PEER_RESTART_DELAY_MS = 1_000;

/** Cancellable P2P voice lifecycle with deterministic offer ownership. */
export class VoiceManager {
  private readonly peers = new Map<PlayerId, PeerEntry>();
  private roster = new Map<PlayerId, VoiceParticipant>();
  private localStream: MediaStream | undefined;
  private credentials: TurnCredentialsResponse | undefined;
  private credentialRequest: AbortController | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly levels = new Map<PlayerId, AudioMeter>();
  private localMeter: AudioMeter | undefined;
  private lastLocalLevel = 0;
  private audioContext: AudioContext | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private readonly volumes = new Map<PlayerId, number>();
  private readonly speaking = new Set<PlayerId>();
  private lifecycle: VoiceLifecycle = "idle";
  private operation = 0;
  private muted = false;

  constructor(
    private readonly selfId: () => PlayerId,
    private readonly events: VoiceManagerEvents,
    private readonly credentialsPath: string,
  ) {}

  get isJoined(): boolean {
    return this.lifecycle === "joined";
  }

  get isJoining(): boolean {
    return this.lifecycle === "joining";
  }

  get isMuted(): boolean {
    return this.muted;
  }

  async join(): Promise<void> {
    if (this.lifecycle !== "idle") return;
    const operation = ++this.operation;
    this.lifecycle = "joining";

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      if (this.isCurrent(operation, "joining")) {
        this.lifecycle = "idle";
        this.events.onError("无法访问麦克风，请检查浏览器权限");
      }
      return;
    }

    if (!this.isCurrent(operation, "joining")) {
      stopStream(stream);
      return;
    }
    this.localStream = stream;

    const credentialsReady = await this.refreshCredentials(operation, true);
    if (!this.isCurrent(operation, "joining")) {
      stopStream(stream);
      if (this.localStream === stream) this.localStream = undefined;
      return;
    }
    if (!credentialsReady) {
      this.stopLocalResources();
      this.lifecycle = "idle";
      this.events.onJoinedChanged(false, this.muted);
      return;
    }

    this.lifecycle = "joined";
    this.muted = false;
    this.events.sendVoiceState(true, false);
    this.reconcilePeers();
    this.attachLocalMeter();
    this.startLevelMeter();
    this.events.onJoinedChanged(true, false);
    this.emitPeers();
  }

  /** Cancels an in-flight join as well as an established voice session. */
  leave(): void {
    if (this.lifecycle === "idle" || this.lifecycle === "disposed") return;
    const wasJoined = this.lifecycle === "joined";
    this.operation += 1;
    this.lifecycle = "idle";
    if (wasJoined) this.events.sendVoiceState(false, true);
    this.stopLocalResources();
    this.muted = false;
    this.events.onJoinedChanged(false, false);
    this.emitPeers();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    if (this.lifecycle === "joined") this.events.sendVoiceState(true, muted);
    this.events.onJoinedChanged(this.lifecycle === "joined", muted);
    this.emitPeers();
  }

  setPeerVolume(playerId: PlayerId, volume: number): void {
    if (!Number.isFinite(volume)) return;
    const clamped = Math.min(1, Math.max(0, volume));
    this.volumes.set(playerId, clamped);
    const peer = this.peers.get(playerId);
    if (peer) peer.audio.volume = clamped;
    this.emitPeers();
  }

  /** Active voice roster update from the signaling server. */
  updateRoster(participants: ReadonlyArray<VoiceParticipant>): void {
    this.roster = new Map(participants.map((participant) => [participant.playerId, participant]));
    this.reconcilePeers();
    this.emitPeers();
  }

  /** Drops stale peer state while retaining the local microphone during WS recovery. */
  handleSignalingDisconnect(): void {
    for (const playerId of this.peers.keys()) this.dropPeer(playerId);
    this.emitPeers();
  }

  /** Reannounces membership and creates fresh peers after a new welcome. */
  handleSignalingReconnect(participants: ReadonlyArray<VoiceParticipant>): void {
    for (const playerId of this.peers.keys()) this.dropPeer(playerId);
    this.roster = new Map(participants.map((participant) => [participant.playerId, participant]));
    if (this.lifecycle === "joined") this.events.sendVoiceState(true, this.muted);
    this.reconcilePeers();
    this.emitPeers();
  }

  /** Serializes each peer's signaling so ICE cannot overtake its remote description. */
  async handleSignal(fromPlayerId: PlayerId, signal: VoiceSignal): Promise<void> {
    if (this.lifecycle !== "joined") return;
    const participant = this.roster.get(fromPlayerId);
    if (!participant) return;
    const peer = this.ensurePeer(participant);
    const signaling = peer.signaling.then(() => this.applySignal(fromPlayerId, peer, signal));
    peer.signaling = signaling.catch(() => undefined);
    await signaling.catch(() => undefined);
  }

  dispose(): void {
    if (this.lifecycle === "disposed") return;
    const wasJoined = this.lifecycle === "joined";
    this.operation += 1;
    this.lifecycle = "disposed";
    if (wasJoined) this.events.sendVoiceState(false, true);
    this.stopLocalResources();
    this.events.onJoinedChanged(false, false);
    this.emitPeers();
  }

  private isCurrent(operation: number, lifecycle: VoiceLifecycle): boolean {
    return this.operation === operation && this.lifecycle === lifecycle;
  }

  private reconcilePeers(): void {
    if (this.lifecycle !== "joined") return;
    for (const participant of this.roster.values()) {
      if (participant.playerId !== this.selfId()) this.ensurePeer(participant);
    }
    for (const playerId of this.peers.keys()) {
      if (!this.roster.has(playerId)) this.dropPeer(playerId);
    }
  }

  private ensurePeer(participant: VoiceParticipant): PeerEntry {
    const existing = this.peers.get(participant.playerId);
    if (existing && existing.pc.connectionState !== "closed") {
      existing.nickname = participant.nickname;
      return existing;
    }
    if (existing) this.dropPeer(participant.playerId);

    const pc = new RTCPeerConnection({
      iceServers: toRtcIceServers(this.credentials?.iceServers ?? []),
      iceTransportPolicy: "all",
    });
    const audio = new Audio();
    audio.autoplay = true;
    audio.volume = this.volumes.get(participant.playerId) ?? 1;
    const entry: PeerEntry = {
      pc,
      audio,
      nickname: participant.nickname,
      makingOffer: false,
      signaling: Promise.resolve(),
      pendingIce: [],
      restartTimer: undefined,
    };
    this.peers.set(participant.playerId, entry);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }

    pc.onicecandidate = (event) => {
      if (this.lifecycle !== "joined" || this.peers.get(participant.playerId) !== entry) return;
      const candidate = event.candidate;
      this.events.sendVoiceSignal(participant.playerId, {
        _tag: "ice",
        candidate: candidate?.candidate ?? null,
        sdpMid: candidate?.sdpMid ?? null,
        sdpMLineIndex: candidate?.sdpMLineIndex ?? null,
        usernameFragment: candidate?.usernameFragment ?? null,
      });
    };
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      entry.audio.srcObject = stream;
      void entry.audio.play().catch(() => undefined);
      this.attachLevelMeter(participant.playerId, stream);
    };
    pc.onconnectionstatechange = () => {
      this.emitPeers();
      if (pc.connectionState === "failed") this.schedulePeerRestart(participant.playerId, entry);
    };

    if (this.selfId() < participant.playerId) {
      void this.makeOffer(participant.playerId, entry, false);
    }
    return entry;
  }

  private async applySignal(
    fromPlayerId: PlayerId,
    entry: PeerEntry,
    signal: VoiceSignal,
  ): Promise<void> {
    const { pc } = entry;
    if (signal._tag === "offer") {
      if (pc.signalingState === "have-local-offer") {
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      await this.flushPendingIce(entry);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.events.sendVoiceSignal(fromPlayerId, { _tag: "answer", sdp: answer.sdp ?? "" });
      return;
    }
    if (signal._tag === "answer") {
      if (pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        await this.flushPendingIce(entry);
      }
      return;
    }
    const candidate =
      signal.candidate === null
        ? null
        : {
            candidate: signal.candidate,
            sdpMid: signal.sdpMid,
            sdpMLineIndex: signal.sdpMLineIndex,
            usernameFragment: signal.usernameFragment,
          };
    if (pc.remoteDescription === null) {
      entry.pendingIce.push(candidate);
      return;
    }
    await pc.addIceCandidate(candidate);
  }

  private async flushPendingIce(entry: PeerEntry): Promise<void> {
    const candidates = entry.pendingIce.splice(0);
    for (const candidate of candidates) await entry.pc.addIceCandidate(candidate);
  }

  private async makeOffer(
    targetPlayerId: PlayerId,
    entry: PeerEntry,
    iceRestart: boolean,
  ): Promise<void> {
    if (this.lifecycle !== "joined" || entry.makingOffer || entry.pc.signalingState !== "stable") {
      return;
    }
    try {
      entry.makingOffer = true;
      const offer = await entry.pc.createOffer({ iceRestart });
      await entry.pc.setLocalDescription(offer);
      this.events.sendVoiceSignal(targetPlayerId, { _tag: "offer", sdp: offer.sdp ?? "" });
    } catch {
      // A roster update or the scheduled failed-connection restart owns recovery.
    } finally {
      entry.makingOffer = false;
    }
  }

  private schedulePeerRestart(playerId: PlayerId, entry: PeerEntry): void {
    if (
      this.lifecycle !== "joined" ||
      this.selfId() >= playerId ||
      entry.restartTimer !== undefined
    ) {
      return;
    }
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined;
      if (this.peers.get(playerId) !== entry || this.lifecycle !== "joined") return;
      entry.pc.restartIce();
      void this.makeOffer(playerId, entry, true);
    }, PEER_RESTART_DELAY_MS);
  }

  private dropPeer(playerId: PlayerId): void {
    const peer = this.peers.get(playerId);
    if (!peer) return;
    this.peers.delete(playerId);
    if (peer.restartTimer) clearTimeout(peer.restartTimer);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.audio.pause();
    peer.audio.srcObject = null;
    const meter = this.levels.get(playerId);
    meter?.source.disconnect();
    meter?.analyser.disconnect();
    this.levels.delete(playerId);
    this.speaking.delete(playerId);
  }

  private async refreshCredentials(operation: number, reportError: boolean): Promise<boolean> {
    const request = new AbortController();
    this.credentialRequest?.abort();
    this.credentialRequest = request;
    try {
      const response = await fetch(this.credentialsPath, {
        method: "POST",
        signal: request.signal,
      });
      if (!response.ok) throw new Error(`TURN credentials returned ${response.status}`);
      const credentials = decodeTurnCredentials(await response.json());
      if (this.operation !== operation || this.lifecycle === "disposed") return false;
      this.credentials = credentials;
      const iceServers = toRtcIceServers(credentials.iceServers);
      for (const [playerId, peer] of this.peers) {
        try {
          peer.pc.setConfiguration({ iceServers });
          if (
            this.lifecycle === "joined" &&
            this.selfId() < playerId &&
            peer.pc.signalingState === "stable"
          ) {
            peer.pc.restartIce();
            void this.makeOffer(playerId, peer, true);
          }
        } catch {
          this.dropPeer(playerId);
        }
      }
      this.reconcilePeers();
      this.scheduleCredentialRefresh(
        operation,
        Math.max(CREDENTIAL_RETRY_MS, credentials.refreshAfter - Date.now()),
      );
      return true;
    } catch {
      if (reportError && !request.signal.aborted && this.operation === operation) {
        this.events.onError("语音服务暂时不可用");
      }
      return false;
    } finally {
      if (this.credentialRequest === request) this.credentialRequest = undefined;
    }
  }

  private scheduleCredentialRefresh(operation: number, delay: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshCredentials(operation, true).then((refreshed) => {
        if (!refreshed && this.operation === operation && this.lifecycle === "joined") {
          this.scheduleCredentialRefresh(operation, CREDENTIAL_RETRY_MS);
        }
      });
    }, delay);
  }

  private stopLocalResources(): void {
    this.credentialRequest?.abort();
    this.credentialRequest = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    for (const playerId of this.peers.keys()) this.dropPeer(playerId);
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = undefined;
    this.credentials = undefined;
    this.localMeter?.source.disconnect();
    this.localMeter?.analyser.disconnect();
    this.localMeter = undefined;
    this.levels.clear();
    this.speaking.clear();
    this.lastLocalLevel = 0;
    this.events.onLocalLevel(0);
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = undefined;
  }

  private audioMeter(stream: MediaStream): AudioMeter | undefined {
    try {
      this.audioContext ??= new AudioContext();
      if (this.audioContext.state === "suspended") {
        void this.audioContext.resume().catch(() => undefined);
      }
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      return {
        source,
        analyser,
        data: new Uint8Array(analyser.frequencyBinCount),
      };
    } catch {
      return undefined;
    }
  }

  private attachLocalMeter(): void {
    if (!this.localStream) return;
    this.localMeter = this.audioMeter(this.localStream);
  }

  private attachLevelMeter(playerId: PlayerId, stream: MediaStream): void {
    const previous = this.levels.get(playerId);
    previous?.source.disconnect();
    previous?.analyser.disconnect();
    this.levels.delete(playerId);
    const meter = this.audioMeter(stream);
    if (meter) this.levels.set(playerId, meter);
  }

  private startLevelMeter(): void {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = setInterval(() => {
      let changed = false;
      for (const [playerId, meter] of this.levels) {
        const isSpeaking = VoiceManager.rms(meter) > 8;
        if (this.speaking.has(playerId) === isSpeaking) continue;
        if (isSpeaking) this.speaking.add(playerId);
        else this.speaking.delete(playerId);
        changed = true;
      }
      if (changed) this.emitPeers();
      this.sampleLocalLevel();
    }, 100);
  }

  private static rms(meter: Pick<AudioMeter, "analyser" | "data">): number {
    meter.analyser.getByteTimeDomainData(meter.data);
    let sum = 0;
    for (const value of meter.data) sum += (value - 128) ** 2;
    return Math.sqrt(sum / meter.data.length);
  }

  private sampleLocalLevel(): void {
    let level = 0;
    if (this.localMeter && !this.muted) {
      level = Math.min(1, VoiceManager.rms(this.localMeter) / 40);
    }
    const rounded = Math.round(level * 100) / 100;
    if (rounded === this.lastLocalLevel) return;
    this.lastLocalLevel = rounded;
    this.events.onLocalLevel(rounded);
  }

  private emitPeers(): void {
    const views: Array<VoicePeerView> = [];
    for (const [playerId, participant] of this.roster) {
      if (playerId === this.selfId()) continue;
      const peer = this.peers.get(playerId);
      views.push({
        playerId,
        nickname: participant.nickname,
        muted: participant.muted,
        speaking: this.speaking.has(playerId),
        volume: this.volumes.get(playerId) ?? 1,
        connected: peer?.pc.connectionState === "connected",
      });
    }
    views.sort((left, right) => left.playerId.localeCompare(right.playerId));
    this.events.onPeersChanged(views);
  }
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

function toRtcIceServers(servers: ReadonlyArray<IceServer>): Array<RTCIceServer> {
  return servers.map((server) => {
    const iceServer: RTCIceServer = { urls: [...server.urls] };
    if (server.username !== undefined) iceServer.username = server.username;
    if (server.credential !== undefined) iceServer.credential = server.credential;
    return iceServer;
  });
}
