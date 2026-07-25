import type { RoomMetadata } from "../../protocol";
import { AttemptLimiter } from "../access/attempt-limiter";
import { GameRoom } from "../room/game-room";

export class RuntimeServices {
  readonly gameRoom: GameRoom;
  readonly sessionAttempts = new AttemptLimiter();
  readonly turnCredentialAttempts = new AttemptLimiter(12, 10 * 60_000);

  constructor(roomMetadata: RoomMetadata) {
    this.gameRoom = new GameRoom(roomMetadata);
  }

  dispose(): void {
    this.gameRoom.dispose();
  }
}
