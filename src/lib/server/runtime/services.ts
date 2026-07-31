import type { RoomMetadata } from "../../protocol";
import { AttemptLimiter } from "../access/attempt-limiter";
import { MusicSourceService } from "../music/service";
import { GameRoom } from "../room/game-room";
import type { RuntimeConfig } from "./config";

export class RuntimeServices {
  readonly gameRoom: GameRoom;
  readonly music: MusicSourceService;
  readonly sessionAttempts = new AttemptLimiter();
  readonly turnCredentialAttempts = new AttemptLimiter(12, 10 * 60_000);
  readonly musicResolveAttempts = new AttemptLimiter(30, 60_000);

  constructor(
    roomMetadata: RoomMetadata,
    music: MusicSourceService = MusicSourceService.disabled(),
  ) {
    this.gameRoom = new GameRoom(roomMetadata, music);
    this.music = music;
  }

  static async create(roomMetadata: RoomMetadata, config: RuntimeConfig): Promise<RuntimeServices> {
    const music = await MusicSourceService.create({ sourceFile: config.musicSourceFile });
    return new RuntimeServices(roomMetadata, music);
  }

  async dispose(): Promise<void> {
    this.gameRoom.dispose();
    await this.music.dispose();
  }
}
