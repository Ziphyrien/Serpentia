import { Assets, Rectangle, Texture } from "pixi.js";
import { INTERNAL_SKINS, type InternalSkin } from "$lib/game/internal-skins";
import { ASSET_PATHS } from "../config";

/** 一套皮肤的图集切片：帧名到 Pixi 贴图。 */
export type SkinFrameTextures = ReadonlyMap<string, Texture>;

export interface GameTextures {
  /** 皮肤 ID 到该皮肤全部帧贴图的映射。 */
  readonly skinFrames: ReadonlyMap<number, SkinFrameTextures>;
  readonly speedUp: Texture;
  readonly protect: Texture;
  readonly foods: ReadonlyArray<Texture>;
  readonly starFood: Texture;
  readonly candy: ReadonlyArray<Texture>;
}

/** 加载全部内置皮肤图集、食物、残骸、加速流光与保护光罩贴图。 */
export async function loadGameTextures(): Promise<GameTextures> {
  const [skinFrames, speedUp, protect, foods, starFood, candy] = await Promise.all([
    loadSkinFrames(),
    Assets.load<Texture>(ASSET_PATHS.effects.speedUp),
    Assets.load<Texture>(ASSET_PATHS.effects.protect),
    Promise.all(ASSET_PATHS.food.dots.map((path) => Assets.load<Texture>(path))),
    Assets.load<Texture>(ASSET_PATHS.food.star),
    Promise.all(ASSET_PATHS.wrecks.map((path) => Assets.load<Texture>(path))),
  ]);

  return { skinFrames, speedUp, protect, foods, starFood, candy };
}

async function loadSkinFrames(): Promise<ReadonlyMap<number, SkinFrameTextures>> {
  const loaded = await Promise.all(
    INTERNAL_SKINS.map(async (skin) => {
      const atlas = await Assets.load<Texture>(skin.atlas.path);
      return [skin.id, sliceAtlas(skin, atlas)] as const;
    }),
  );
  return new Map(loaded);
}

/**
 * 按官方帧矩形切分图集。
 *
 * 打包时旋转过的帧在图集里宽高互换，因此裁剪区域用 `height × width`，
 * 原始尺寸仍是 `width × height`，再交给 Pixi 的 `rotate: 2` 转回来。
 */
function sliceAtlas(skin: InternalSkin, atlas: Texture): SkinFrameTextures {
  const textures = new Map<string, Texture>();
  for (const [name, frame] of Object.entries(skin.frames)) {
    const region = frame.rotated
      ? new Rectangle(frame.x, frame.y, frame.height, frame.width)
      : new Rectangle(frame.x, frame.y, frame.width, frame.height);
    textures.set(
      name,
      new Texture({
        source: atlas.source,
        frame: region,
        orig: new Rectangle(0, 0, frame.width, frame.height),
        rotate: frame.rotated ? 2 : 0,
        label: `skin-${skin.id}-${name}`,
      }),
    );
  }
  return textures;
}
