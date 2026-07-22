import { GameRoom } from "../game-room";

export { GameRoom };

export default {
  fetch(request, env) {
    return env.GAME_ROOM.getByName("friends").fetch(request);
  },
} satisfies ExportedHandler<Env>;
