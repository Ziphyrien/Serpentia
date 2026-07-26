import { Assets, type Texture } from "pixi.js";
import { ASSET_PATHS } from "../config";

export interface SnakeSkinTextures {
  readonly head: Texture;
  readonly body: Texture;
}

export interface GameTextures {
  readonly arenaBackground: Texture;
  readonly snakeSkins: ReadonlyArray<SnakeSkinTextures>;
  readonly foods: ReadonlyArray<Texture>;
  readonly remainsFood: Texture;
}

/** 加载从 Snake-Demo 原工程按 Unity GUID 对应出的游戏 Sprite。 */
export async function loadGameTextures(): Promise<GameTextures> {
  const [arenaBackground, snakeSkins, foods, remainsFood] = await Promise.all([
    Assets.load<Texture>(ASSET_PATHS.snakeDemo.arenaBackground),
    Promise.all(
      ASSET_PATHS.snakeDemo.snakeSkins.map(async (skin) => {
        const [head, body] = await Promise.all([
          Assets.load<Texture>(skin.head),
          Assets.load<Texture>(skin.body),
        ]);
        return { head, body };
      }),
    ),
    Promise.all(ASSET_PATHS.snakeDemo.foods.map((path) => Assets.load<Texture>(path))),
    Assets.load<Texture>(ASSET_PATHS.snakeDemo.remainsFood),
  ]);

  return { arenaBackground, snakeSkins, foods, remainsFood };
}
