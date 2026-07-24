import { Assets, Texture } from "pixi.js";
import { ASSET_PATHS, SKINS } from "../config";

export interface GameTextures {
  /** skinId → 头部纹理；加载失败的皮肤缺省为 undefined，渲染时降级为圆形头 */
  heads: Map<string, Texture>;
  foodPearl: Texture | undefined;
  foodGold: Texture | undefined;
  bgTile: Texture | undefined;
}

async function tryLoad(url: string): Promise<Texture | undefined> {
  try {
    return await Assets.load<Texture>(url);
  } catch {
    return undefined;
  }
}

/** 统一加载游戏纹理；单张失败不阻塞整体（降级渲染）。 */
export async function loadGameTextures(): Promise<GameTextures> {
  const entries = await Promise.all(
    SKINS.map(async (skin) => [skin.id, await tryLoad(skin.headTexture)] as const),
  );
  const heads = new Map<string, Texture>();
  for (const [id, texture] of entries) {
    if (texture) heads.set(id, texture);
  }
  const [foodPearl, foodGold, bgTile] = await Promise.all([
    tryLoad(ASSET_PATHS.foodPearl),
    tryLoad(ASSET_PATHS.foodGold),
    tryLoad(ASSET_PATHS.bgTile),
  ]);
  return { heads, foodPearl, foodGold, bgTile };
}

/** 生成食物纹理中主体占比的估算系数（生成图带 padding）。 */
export const FOOD_TEXTURE_CONTENT = 0.6;
