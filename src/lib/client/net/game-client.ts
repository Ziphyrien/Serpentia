import { Effect } from "effect";
import {
  decodeServerMessage,
  GAME_PROTOCOL_VERSION,
  SnapshotStreamDecoder,
  type ClientMessage,
  type ServerMessage,
  type VoiceSignal,
} from "$lib/protocol";
import type { PlayerId } from "$lib/protocol/state";

/** 网络层向上抛出的事件集合，由 GameController 装配。 */
export interface GameClientEvents {
  onMessage(message: ServerMessage): void;
  onClose(code: number, reason: string): void;
  onOpen(): void;
}

/**
 * 单条游戏 WebSocket 连接的生命周期封装（高内聚：只管收发与解码；
 * 重连、心跳、输入节流等策略全部交由上层控制器）。
 */
export class GameClient {
  private socket: WebSocket | undefined;
  private readonly snapshotStream = new SnapshotStreamDecoder();

  constructor(
    private readonly url: string,
    private readonly events: GameClientEvents,
  ) {}

  connect(): void {
    this.snapshotStream.reset();
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => this.events.onOpen();
    socket.onclose = (event) => this.events.onClose(event.code, event.reason);
    socket.onerror = () => {
      // onclose 会随后触发，统一在那里处理
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string" && !(event.data instanceof ArrayBuffer)) return;
      try {
        const message = Effect.runSync(decodeServerMessage(event.data, this.snapshotStream));
        if (message._tag === "welcome") {
          this.snapshotStream.seed(message.snapshot, message.serverTime);
        }
        this.events.onMessage(message);
      } catch {
        // 无法解码的消息直接丢弃（协议演进/异常流量）
      }
    };
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  sendInput(sequence: number, clientTick: number, angle: number, boosting: boolean): void {
    this.send({
      v: GAME_PROTOCOL_VERSION,
      _tag: "input",
      sequence,
      clientTick,
      angle,
      boosting,
    });
  }

  sendPing(nonce: string): void {
    this.send({ v: GAME_PROTOCOL_VERSION, _tag: "ping", nonce });
  }

  sendVoiceState(muted: boolean): void {
    this.send({ v: GAME_PROTOCOL_VERSION, _tag: "voice-state", muted });
  }

  sendVoiceSignal(targetPlayerId: PlayerId, signal: VoiceSignal): void {
    this.send({ v: GAME_PROTOCOL_VERSION, _tag: "voice-signal", targetPlayerId, signal });
  }

  close(): void {
    if (!this.socket) return;
    this.socket.onclose = null;
    this.socket.onmessage = null;
    this.socket.onerror = null;
    this.socket.onopen = null;
    try {
      this.socket.close(1000, "client closing");
    } catch {
      // 已关闭
    }
    this.socket = undefined;
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
