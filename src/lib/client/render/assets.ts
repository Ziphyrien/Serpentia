import { Assets, Texture } from "pixi.js";
import { ASSET_PATHS } from "../config";

export interface GameTextures {
  /** 背景地砖；蛇与食物均为程序化绘制，无需纹理。 */
  bgTile: Texture | undefined;
}

/** 加载游戏纹理；失败时降级为纯色背景，不阻塞进入游戏。 */
export async function loadGameTextures(): Promise<GameTextures> {
  try {
    return { bgTile: await Assets.load<Texture>(ASSET_PATHS.bgTile) };
  } catch {
    return { bgTile: undefined };
  }
}
