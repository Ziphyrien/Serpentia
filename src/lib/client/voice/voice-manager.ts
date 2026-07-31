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
  audioTransceiver: RTCRtpTransceiver | undefined;
  nickname: string;
  makingOffer: boolean;
  negotiationPending: boolean;
  iceRestartPending: boolean;
  negotiationTimer: ReturnType<typeof setTimeout> | undefined;
  signaling: Promise<void>;
  pendingIce: Array<RTCIceCandidateInit | null>;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
}

type VoiceLifecycle = "idle" | "joining" | "joined" | "disposed";

export interface VoicePeerView {
  playerId: PlayerId;
  nickname: string;
  microphoneEnabled: boolean;
  speaking: boolean;
  volume: number;
  connected: boolean;
}

export interface VoiceManagerEvents {
  onPeersChanged(peers: Array<VoicePeerView>): void;
  onJoinedChanged(joined: boolean): void;
  onLocalLevel(level: number): void;
  onError(message: string): void;
  sendVoiceSignal(targetPlayerId: PlayerId, signal: VoiceSignal): void;
  sendVoiceState(listening: boolean, microphoneEnabled: boolean): void;
}

const decodeTurnCredentials = Schema.decodeUnknownSync(TurnCredentialsResponse);
const CREDENTIAL_RETRY_MS = 30_000;
const SILENT_LISTEN_RETRY_DELAYS_MS: ReadonlyArray<number> = [150, 300, 600];
const PEER_RESTART_DELAY_MS = 1_000;
const NEGOTIATION_RETRY_DELAY_MS = 250;
const DEFAULT_PEER_VOLUME = 1;

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
  private listening = false;
  private listeningRequest: Promise<boolean> | undefined;
  private listeningOperation = 0;
  private microphoneOperation = 0;
  private audioUnlockInstalled = false;

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

  /** Establishes receive-only signaling without requesting microphone access. */
  startListening(): Promise<boolean> {
    if (this.lifecycle === "disposed") return Promise.resolve(false);
    if (this.listening) return Promise.resolve(true);
    if (this.listeningRequest !== undefined) return this.listeningRequest;

    const operation = ++this.listeningOperation;
    const request = this.establishListening(operation).catch(() => false);
    const tracked = request.finally(() => {
      if (this.listeningRequest === tracked) this.listeningRequest = undefined;
    });
    this.listeningRequest = tracked;
    return tracked;
  }

  async join(): Promise<void> {
    if (this.lifecycle !== "idle") return;
    const operation = ++this.microphoneOperation;
    this.lifecycle = "joining";
    const listeningReadyPromise = this.startListening();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      if (this.isCurrentMicrophone(operation, "joining")) {
        this.lifecycle = "idle";
        this.events.onError("无法访问麦克风，请检查浏览器权限");
      }
      return;
    }

    if (!this.isCurrentMicrophone(operation, "joining")) {
      stopStream(stream);
      return;
    }
    const listeningReady = await listeningReadyPromise;
    if (!this.isCurrentMicrophone(operation, "joining")) {
      stopStream(stream);
      return;
    }
    if (!listeningReady) {
      stopStream(stream);
      this.lifecycle = "idle";
      this.events.onError("语音服务暂时不可用");
      this.events.onJoinedChanged(false);
      return;
    }

    this.localStream = stream;
    const microphoneReady = await this.attachMicrophoneTrack(stream);
    if (!this.isCurrentMicrophone(operation, "joining")) {
      stopStream(stream);
      if (this.localStream === stream) this.localStream = undefined;
      return;
    }
    if (!microphoneReady) {
      this.lifecycle = "idle";
      this.stopMicrophoneResources();
      this.events.onError("麦克风发布失败，请重试");
      this.events.onJoinedChanged(false);
      return;
    }

    this.lifecycle = "joined";
    this.events.sendVoiceState(true, true);
    this.attachLocalMeter();
    this.startLevelMeter();
    this.events.onJoinedChanged(true);
    this.emitPeers();
  }

  /** Stops microphone publication while keeping receive-only voice active. */
  leave(): void {
    if (this.lifecycle === "idle" || this.lifecycle === "disposed") return;
    const wasJoined = this.lifecycle === "joined";
    this.microphoneOperation += 1;
    this.lifecycle = "idle";
    this.stopMicrophoneResources();
    if (wasJoined && this.listening) this.events.sendVoiceState(true, false);
    this.events.onJoinedChanged(false);
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
    this.dropAllPeers();
    this.emitPeers();
  }

  /** Reannounces receive and microphone state after a new welcome. */
  handleSignalingReconnect(participants: ReadonlyArray<VoiceParticipant>): void {
    this.dropAllPeers();
    this.roster = new Map(participants.map((participant) => [participant.playerId, participant]));
    if (this.listening) {
      const microphoneEnabled = this.lifecycle === "joined";
      this.events.sendVoiceState(true, microphoneEnabled);
    }
    this.reconcilePeers();
    this.emitPeers();
  }

  /** Serializes each peer's signaling so ICE cannot overtake its remote description. */
  async handleSignal(fromPlayerId: PlayerId, signal: VoiceSignal): Promise<void> {
    if (!this.listening) return;
    const participant = this.roster.get(fromPlayerId);
    if (!participant) return;
    const peer = this.ensurePeer(participant);
    const signaling = peer.signaling.then(async () => {
      await this.applySignal(fromPlayerId, peer, signal);
      await this.makePendingOffer(fromPlayerId, peer);
    });
    peer.signaling = signaling.catch(() => undefined);
    await signaling.catch(() => undefined);
  }

  dispose(): void {
    if (this.lifecycle === "disposed") return;
    this.microphoneOperation += 1;
    this.listeningOperation += 1;
    this.lifecycle = "disposed";
    if (this.listening) this.events.sendVoiceState(false, false);
    this.listening = false;
    this.listeningRequest = undefined;
    this.stopListeningResources();
    this.events.onJoinedChanged(false);
    this.emitPeers();
  }

  private isCurrentMicrophone(operation: number, lifecycle: VoiceLifecycle): boolean {
    return this.microphoneOperation === operation && this.lifecycle === lifecycle;
  }

  private isCurrentListening(operation: number): boolean {
    return this.listeningOperation === operation && this.lifecycle !== "disposed";
  }

  private reconcilePeers(): void {
    if (!this.listening) return;
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
    audio.volume = this.volumes.get(participant.playerId) ?? DEFAULT_PEER_VOLUME;
    const isOfferOwner = this.selfId() < participant.playerId;
    const localTrack = this.localStream?.getAudioTracks()[0];
    const audioTransceiver = isOfferOwner
      ? localTrack !== undefined && this.localStream !== undefined
        ? pc.addTransceiver(localTrack, {
            direction: "sendrecv",
            streams: [this.localStream],
          })
        : pc.addTransceiver("audio", { direction: "sendrecv" })
      : undefined;
    const entry: PeerEntry = {
      pc,
      audio,
      audioTransceiver,
      nickname: participant.nickname,
      makingOffer: false,
      negotiationPending: false,
      iceRestartPending: false,
      negotiationTimer: undefined,
      signaling: Promise.resolve(),
      pendingIce: [],
      restartTimer: undefined,
    };
    this.peers.set(participant.playerId, entry);

    pc.onicecandidate = (event) => {
      if (!this.listening || this.peers.get(participant.playerId) !== entry) return;
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
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      entry.audio.srcObject = stream;
      this.playPeerAudio(entry);
      this.attachLevelMeter(participant.playerId, stream);
    };
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable" && entry.negotiationPending) {
        this.requestOffer(participant.playerId, entry, false);
      }
    };
    pc.onconnectionstatechange = () => {
      this.emitPeers();
      if (pc.connectionState === "failed") this.schedulePeerRestart(participant.playerId, entry);
    };

    if (isOfferOwner) {
      this.requestOffer(participant.playerId, entry, false);
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
      const transceiver = findAudioTransceiver(pc, signal.sdp);
      if (transceiver === undefined) throw new Error("Audio transceiver was not created");
      entry.audioTransceiver = transceiver;
      transceiver.direction = answerDirectionForOffer(signal.sdp);
      const localTrack = this.localStream?.getAudioTracks()[0];
      if (localTrack !== undefined && !(await this.attachTrack(transceiver, localTrack))) {
        throw new Error("Microphone track could not be attached");
      }
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

  private requestOffer(targetPlayerId: PlayerId, entry: PeerEntry, iceRestart: boolean): void {
    if (!this.listening || this.peers.get(targetPlayerId) !== entry) return;
    entry.negotiationPending = true;
    entry.iceRestartPending ||= iceRestart;
    const signaling = entry.signaling.then(() => this.makePendingOffer(targetPlayerId, entry));
    entry.signaling = signaling.catch(() => undefined);
  }

  private async makePendingOffer(targetPlayerId: PlayerId, entry: PeerEntry): Promise<void> {
    if (
      !this.listening ||
      this.peers.get(targetPlayerId) !== entry ||
      !entry.negotiationPending ||
      entry.makingOffer ||
      entry.pc.signalingState !== "stable"
    ) {
      return;
    }

    const iceRestart = entry.iceRestartPending;
    entry.negotiationPending = false;
    entry.iceRestartPending = false;
    if (entry.negotiationTimer !== undefined) clearTimeout(entry.negotiationTimer);
    entry.negotiationTimer = undefined;
    entry.makingOffer = true;
    try {
      const offer = await entry.pc.createOffer({ iceRestart });
      await entry.pc.setLocalDescription(offer);
      this.events.sendVoiceSignal(targetPlayerId, { _tag: "offer", sdp: offer.sdp ?? "" });
    } catch {
      entry.negotiationPending = true;
      entry.iceRestartPending ||= iceRestart;
      this.scheduleNegotiationRetry(targetPlayerId, entry);
    } finally {
      entry.makingOffer = false;
    }
  }

  private scheduleNegotiationRetry(playerId: PlayerId, entry: PeerEntry): void {
    if (entry.negotiationTimer !== undefined) return;
    entry.negotiationTimer = setTimeout(() => {
      entry.negotiationTimer = undefined;
      if (this.peers.get(playerId) === entry && this.listening) {
        this.requestOffer(playerId, entry, false);
      }
    }, NEGOTIATION_RETRY_DELAY_MS);
  }

  private schedulePeerRestart(playerId: PlayerId, entry: PeerEntry): void {
    if (!this.listening || this.selfId() >= playerId || entry.restartTimer !== undefined) {
      return;
    }
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined;
      if (this.peers.get(playerId) !== entry || !this.listening) return;
      entry.pc.restartIce();
      this.requestOffer(playerId, entry, true);
    }, PEER_RESTART_DELAY_MS);
  }

  private dropAllPeers(): void {
    for (const playerId of this.peers.keys()) this.dropPeer(playerId);
  }

  private dropPeer(playerId: PlayerId): void {
    const peer = this.peers.get(playerId);
    if (!peer) return;
    this.peers.delete(playerId);
    if (peer.restartTimer) clearTimeout(peer.restartTimer);
    if (peer.negotiationTimer) clearTimeout(peer.negotiationTimer);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onsignalingstatechange = null;
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

  private async establishListening(operation: number): Promise<boolean> {
    const cached = this.reuseCachedCredentials(operation);
    if (!cached && !(await this.fetchCredentialsWithRetry(operation))) return false;
    if (!this.isCurrentListening(operation)) return false;

    this.listening = true;
    this.installAudioUnlock();
    const microphoneEnabled = this.lifecycle === "joined";
    this.events.sendVoiceState(true, microphoneEnabled);
    this.reconcilePeers();
    this.emitPeers();
    return true;
  }

  private async attachMicrophoneTrack(stream: MediaStream): Promise<boolean> {
    const track = stream.getAudioTracks()[0];
    if (track === undefined) return false;

    let ready = true;
    for (const [playerId, peer] of Array.from(this.peers)) {
      if (this.peers.get(playerId) !== peer) continue;
      if (peer.audioTransceiver === undefined) continue;
      const attached = await this.attachTrack(peer.audioTransceiver, track);
      ready &&= attached;
    }
    return ready;
  }

  private async attachTrack(
    transceiver: RTCRtpTransceiver,
    track: MediaStreamTrack,
  ): Promise<boolean> {
    try {
      await transceiver.sender.replaceTrack(track);
      return transceiver.sender.track === track;
    } catch {
      return false;
    }
  }

  private async fetchCredentialsWithRetry(operation: number): Promise<boolean> {
    for (const delay of [0, ...SILENT_LISTEN_RETRY_DELAYS_MS]) {
      if (delay > 0) await wait(delay);
      if (!this.isCurrentListening(operation)) return false;
      if (await this.refreshCredentials(operation, false)) return true;
    }
    return false;
  }

  private reuseCachedCredentials(operation: number): boolean {
    const credentials = this.credentials;
    const refreshDelay = (credentials?.refreshAfter ?? 0) - Date.now();
    if (credentials === undefined || refreshDelay <= 0) {
      this.credentials = undefined;
      return false;
    }
    this.scheduleCredentialRefresh(operation, Math.max(CREDENTIAL_RETRY_MS, refreshDelay));
    return true;
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
      if (!this.isCurrentListening(operation)) return false;
      this.credentials = credentials;
      const iceServers = toRtcIceServers(credentials.iceServers);
      for (const [playerId, peer] of this.peers) {
        try {
          peer.pc.setConfiguration({ iceServers });
          if (this.listening && this.selfId() < playerId) {
            peer.pc.restartIce();
            this.requestOffer(playerId, peer, true);
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
      if (reportError && !request.signal.aborted && this.isCurrentListening(operation)) {
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
        if (!refreshed && this.isCurrentListening(operation) && this.listening) {
          this.scheduleCredentialRefresh(operation, CREDENTIAL_RETRY_MS);
        }
      });
    }, delay);
  }

  private stopMicrophoneResources(): void {
    for (const peer of this.peers.values()) {
      if (peer.audioTransceiver !== undefined) {
        void peer.audioTransceiver.sender.replaceTrack(null).catch(() => undefined);
      }
    }
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = undefined;
    this.localMeter?.source.disconnect();
    this.localMeter?.analyser.disconnect();
    this.localMeter = undefined;
    this.lastLocalLevel = 0;
    this.events.onLocalLevel(0);
  }

  private stopListeningResources(): void {
    this.stopMicrophoneResources();
    this.credentialRequest?.abort();
    this.credentialRequest = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    this.dropAllPeers();
    this.credentials = undefined;
    this.levels.clear();
    this.speaking.clear();
    this.removeAudioUnlock();
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = undefined;
  }

  private installAudioUnlock(): void {
    if (this.audioUnlockInstalled || typeof window === "undefined") return;
    this.audioUnlockInstalled = true;
    window.addEventListener("pointerup", this.unlockAudio, { capture: true, passive: true });
    window.addEventListener("keydown", this.unlockAudio, { capture: true });
  }

  private removeAudioUnlock(): void {
    if (!this.audioUnlockInstalled || typeof window === "undefined") return;
    this.audioUnlockInstalled = false;
    window.removeEventListener("pointerup", this.unlockAudio, { capture: true });
    window.removeEventListener("keydown", this.unlockAudio, { capture: true });
  }

  private readonly unlockAudio = (): void => {
    for (const peer of this.peers.values()) this.playPeerAudio(peer);
    if (this.audioContext?.state === "suspended") {
      void this.audioContext.resume().catch(() => undefined);
    }
  };

  private playPeerAudio(peer: PeerEntry): void {
    void peer.audio.play().catch(() => undefined);
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
    if (meter) {
      this.levels.set(playerId, meter);
      this.startLevelMeter();
    }
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
    if (this.localMeter) {
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
        microphoneEnabled: participant.microphoneEnabled,
        speaking: this.speaking.has(playerId),
        volume: this.volumes.get(playerId) ?? DEFAULT_PEER_VOLUME,
        connected: peer?.pc.connectionState === "connected",
      });
    }
    views.sort((left, right) => left.playerId.localeCompare(right.playerId));
    this.events.onPeersChanged(views);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

function findAudioTransceiver(pc: RTCPeerConnection, sdp: string): RTCRtpTransceiver | undefined {
  const audioMid = audioMidFromSdp(sdp);
  if (audioMid !== undefined) {
    const matching = pc.getTransceivers().find((transceiver) => transceiver.mid === audioMid);
    if (matching !== undefined) return matching;
  }
  return pc.getTransceivers().find((transceiver) => transceiver.receiver.track.kind === "audio");
}

function audioMidFromSdp(sdp: string): string | undefined {
  let inAudioSection = false;
  for (const line of sdp.split(/\r?\n/u)) {
    if (line.startsWith("m=")) inAudioSection = line.startsWith("m=audio ");
    else if (inAudioSection && line.startsWith("a=mid:")) return line.slice("a=mid:".length);
  }
  return undefined;
}

function answerDirectionForOffer(sdp: string): RTCRtpTransceiverDirection {
  let inAudioSection = false;
  for (const line of sdp.split(/\r?\n/u)) {
    if (line.startsWith("m=")) {
      inAudioSection = line.startsWith("m=audio ");
      continue;
    }
    if (!inAudioSection) continue;
    if (line === "a=sendrecv") return "sendrecv";
    if (line === "a=recvonly") return "sendonly";
    if (line === "a=sendonly") return "recvonly";
    if (line === "a=inactive") return "inactive";
  }
  return "sendrecv";
}

function toRtcIceServers(servers: ReadonlyArray<IceServer>): Array<RTCIceServer> {
  return servers.map((server) => {
    const iceServer: RTCIceServer = { urls: [...server.urls] };
    if (server.username !== undefined) iceServer.username = server.username;
    if (server.credential !== undefined) iceServer.credential = server.credential;
    return iceServer;
  });
}
