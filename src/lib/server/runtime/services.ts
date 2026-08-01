import type { RoomMetadata } from "../../protocol";
import { AttemptLimiter } from "../access/attempt-limiter";
import { MusicBackendService } from "../music/service";
import { GameRoom } from "../room/game-room";
import type { RuntimeConfig } from "./config";

export class RuntimeServices {
  readonly gameRoom: GameRoom;
  readonly music: MusicBackendService;
  readonly sessionAttempts = new AttemptLimiter();
  readonly turnCredentialAttempts = new AttemptLimiter(12, 10 * 60_000);
  readonly musicSearchAttempts = new AttemptLimiter(20, 60_000);

  constructor(
    roomMetadata: RoomMetadata,
    music: MusicBackendService = MusicBackendService.disabled(),
  ) {
    this.gameRoom = new GameRoom(roomMetadata, music);
    this.music = music;
  }

  static async create(roomMetadata: RoomMetadata, config: RuntimeConfig): Promise<RuntimeServices> {
    const music = await MusicBackendService.create({
      bilibiliCookie: config.bilibiliCookie,
      refreshToken: config.bilibiliRefreshToken,
      environmentFile: config.bilibiliEnvironmentFile,
      signingSecret: config.sessionSigningSecret,
    });
    return new RuntimeServices(roomMetadata, music);
  }

  async dispose(): Promise<void> {
    this.gameRoom.dispose();
    await this.music.dispose();
  }
}
