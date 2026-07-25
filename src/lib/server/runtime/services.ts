import type { RoomMetadata } from "../../protocol";
import { AccessAttemptLimiter } from "../access/attempt-limiter";
import { GameRoom } from "../room/game-room";

export class RuntimeServices {
  readonly gameRoom: GameRoom;
  readonly accessAttempts = new AccessAttemptLimiter();
  readonly turnCredentialAttempts = new AccessAttemptLimiter(12, 10 * 60_000);

  constructor(roomMetadata: RoomMetadata) {
    this.gameRoom = new GameRoom(roomMetadata);
  }

  dispose(): void {
    this.gameRoom.dispose();
  }
}
