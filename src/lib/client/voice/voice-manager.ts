import type {
  PlayerId,
  TurnCredentialsResponse,
  VoiceParticipant,
  VoiceSignal,
} from "$lib/protocol";

interface PeerEntry {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  nickname: string;
  makingOffer: boolean;
}

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
  /** 本地麦克风实时电平（0-1），约每 100ms 有变化时回调。 */
  onLocalLevel(level: number): void;
  onError(message: string): void;
  sendVoiceSignal(targetPlayerId: PlayerId, signal: VoiceSignal): void;
  sendVoiceState(muted: boolean): void;
}

/**
 * P2P 语音 mesh 管理器（严格按 docs/backend-api.md 契约）：
 * - 字典序较小的 playerId 主动 offer，避免 glare
 * - TURN 凭据在 refreshAfter 后刷新并 setConfiguration
 * - roster 增减驱动连接生命周期
 * 不依赖 Svelte，通过事件回调向外暴露状态。
 */
export class VoiceManager {
  private peers = new Map<PlayerId, PeerEntry>();
  private roster = new Map<PlayerId, VoiceParticipant>();
  private localStream: MediaStream | undefined;
  private credentials: TurnCredentialsResponse | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private levels = new Map<PlayerId, { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }>();
  private localMeter:
    | { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }
    | undefined;
  private lastLocalLevel = 0;
  private audioContext: AudioContext | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private volumes = new Map<PlayerId, number>();
  private speaking = new Set<PlayerId>();
  private joined = false;
  private muted = false;

  constructor(
    private readonly selfId: () => PlayerId,
    private readonly events: VoiceManagerEvents,
  ) {}

  get isJoined(): boolean {
    return this.joined;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** 加入语音：获取麦克风 + 拉取 TURN 凭据 + 按现有 roster 建连。 */
  async join(): Promise<void> {
    if (this.joined) return;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      this.events.onError("无法访问麦克风，请检查浏览器权限");
      return;
    }
    if (!(await this.refreshCredentials())) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = undefined;
      return;
    }
    this.joined = true;
    this.muted = false;
    this.events.sendVoiceState(false);
    for (const participant of this.roster.values()) {
      if (participant.playerId !== this.selfId()) this.ensurePeer(participant);
    }
    this.attachLocalMeter();
    this.startLevelMeter();
    this.events.onJoinedChanged(true, this.muted);
    this.emitPeers();
  }

  leave(): void {
    if (!this.joined) return;
    this.joined = false;
    for (const playerId of this.peers.keys()) this.dropPeer(playerId);
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    this.levels.clear();
    this.localMeter?.source.disconnect();
    this.localMeter = undefined;
    this.lastLocalLevel = 0;
    this.events.onLocalLevel(0);
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = undefined;
    this.events.onJoinedChanged(false, this.muted);
    this.emitPeers();
  }

  /** 静音只改本地 track.enabled + 上报 roster，不断流。 */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    if (this.joined) this.events.sendVoiceState(muted);
    this.events.onJoinedChanged(this.joined, this.muted);
    this.emitPeers();
  }

  setPeerVolume(playerId: PlayerId, volume: number): void {
    this.volumes.set(playerId, volume);
    const peer = this.peers.get(playerId);
    if (peer) peer.audio.volume = volume;
    this.emitPeers();
  }

  /** 服务端 voice-roster 到达：增量建连/断开。 */
  updateRoster(participants: ReadonlyArray<VoiceParticipant>): void {
    this.roster = new Map(participants.map((p) => [p.playerId, p]));
    if (!this.joined) {
      this.emitPeers();
      return;
    }
    for (const participant of participants) {
      if (participant.playerId === this.selfId()) continue;
      this.ensurePeer(participant);
    }
    for (const playerId of this.peers.keys()) {
      if (!this.roster.has(playerId)) this.dropPeer(playerId);
    }
    this.emitPeers();
  }

  /** 服务端转发的信令。 */
  async handleSignal(fromPlayerId: PlayerId, signal: VoiceSignal): Promise<void> {
    if (!this.joined) return;
    const peer = this.peers.get(fromPlayerId);
    if (!peer) return;
    const { pc } = peer;
    try {
      if (signal._tag === "offer") {
        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.events.sendVoiceSignal(fromPlayerId, { _tag: "answer", sdp: answer.sdp ?? "" });
      } else if (signal._tag === "answer") {
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      } else {
        await pc.addIceCandidate(
          signal.candidate === null
            ? null
            : {
                candidate: signal.candidate,
                sdpMid: signal.sdpMid,
                sdpMLineIndex: signal.sdpMLineIndex,
                usernameFragment: signal.usernameFragment,
              },
        );
      }
    } catch {
      // 信令乱序/超时由下一轮 ICE 重启自然恢复
    }
  }

  dispose(): void {
    this.leave();
  }

  private ensurePeer(participant: VoiceParticipant): PeerEntry {
    const existing = this.peers.get(participant.playerId);
    if (existing) {
      existing.nickname = participant.nickname;
      return existing;
    }
    const pc = new RTCPeerConnection({
      iceServers: (this.credentials?.iceServers ?? []) as RTCIceServer[],
      iceTransportPolicy: "all",
    });
    const audio = new Audio();
    audio.autoplay = true;
    audio.volume = this.volumes.get(participant.playerId) ?? 1;
    const entry: PeerEntry = { pc, audio, nickname: participant.nickname, makingOffer: false };
    this.peers.set(participant.playerId, entry);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }

    pc.onicecandidate = (event) => {
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
      if (stream) {
        entry.audio.srcObject = stream;
        this.attachLevelMeter(participant.playerId, stream);
      }
    };
    pc.onconnectionstatechange = () => this.emitPeers();

    // 契约约定：字典序较小的一方主动 offer
    if (this.selfId() < participant.playerId) {
      void this.makeOffer(participant.playerId, entry);
    }
    return entry;
  }

  private async makeOffer(targetPlayerId: PlayerId, entry: PeerEntry): Promise<void> {
    try {
      entry.makingOffer = true;
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.events.sendVoiceSignal(targetPlayerId, { _tag: "offer", sdp: offer.sdp ?? "" });
    } catch {
      // 对方离线等场景，roster 更新会清理
    } finally {
      entry.makingOffer = false;
    }
  }

  private dropPeer(playerId: PlayerId): void {
    const peer = this.peers.get(playerId);
    if (!peer) return;
    peer.pc.close();
    peer.audio.srcObject = null;
    this.peers.delete(playerId);
    this.levels.delete(playerId);
    this.speaking.delete(playerId);
  }

  private async refreshCredentials(): Promise<boolean> {
    try {
      const response = await fetch("/api/turn-credentials", { method: "POST" });
      if (!response.ok) {
        this.events.onError("语音凭据获取失败，请稍后再试");
        return false;
      }
      const credentials = (await response.json()) as TurnCredentialsResponse;
      this.credentials = credentials;
      const iceServers = credentials.iceServers as Array<RTCIceServer>;
      for (const peer of this.peers.values()) peer.pc.setConfiguration({ iceServers });
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      const delay = Math.max(30_000, credentials.refreshAfter - Date.now());
      this.refreshTimer = setTimeout(() => void this.refreshCredentials(), delay);
      return true;
    } catch {
      this.events.onError("语音服务暂时不可用");
      return false;
    }
  }

  /** 给本地麦克风挂分析器，用于按钮上的音量指示（不送扬声器，避免回授）。 */
  private attachLocalMeter(): void {
    if (!this.localStream) return;
    try {
      this.audioContext ??= new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.localStream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data: Uint8Array<ArrayBuffer> = new Uint8Array(analyser.frequencyBinCount);
      this.localMeter = { source, analyser, data };
    } catch {
      // 电平指示只是增强，失败不影响通话
    }
  }

  private attachLevelMeter(playerId: PlayerId, stream: MediaStream): void {
    try {
      this.audioContext ??= new AudioContext();
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data: Uint8Array<ArrayBuffer> = new Uint8Array(analyser.frequencyBinCount);
      this.levels.set(playerId, { analyser, data });
    } catch {
      // 电平指示只是增强，失败不影响通话
    }
  }

  private startLevelMeter(): void {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = setInterval(() => {
      let changed = false;
      for (const [playerId, meter] of this.levels) {
        const rms = VoiceManager.rms(meter);
        const isSpeaking = rms > 8;
        if (this.speaking.has(playerId) !== isSpeaking) {
          if (isSpeaking) this.speaking.add(playerId);
          else this.speaking.delete(playerId);
          changed = true;
        }
      }
      if (changed) this.emitPeers();
      this.sampleLocalLevel();
    }, 100);
  }

  private static rms(meter: { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }): number {
    meter.analyser.getByteTimeDomainData(meter.data);
    let sum = 0;
    for (const value of meter.data) sum += (value - 128) ** 2;
    return Math.sqrt(sum / meter.data.length);
  }

  /** 采样本地麦克风电平并归一化到 0-1；静音时恒为 0。 */
  private sampleLocalLevel(): void {
    let level = 0;
    if (this.localMeter && !this.muted) {
      const rms = VoiceManager.rms(this.localMeter);
      level = Math.min(1, rms / 40);
    }
    const rounded = Math.round(level * 100) / 100;
    if (rounded !== this.lastLocalLevel) {
      this.lastLocalLevel = rounded;
      this.events.onLocalLevel(rounded);
    }
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
    views.sort((a, b) => a.playerId.localeCompare(b.playerId));
    this.events.onPeersChanged(views);
  }
}
