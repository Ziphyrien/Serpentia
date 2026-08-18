import manifest from "./internal-skins.json";
import { SNAKE_BODY, SNAKE_MOTION } from "./snake-motion";

/** 图集内的一帧；`rotated` 表示打包时顺时针旋转了 90°。 */
export interface SkinFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotated: boolean;
}

/** 原版 `SkinNode`：一组循环播放的帧，外加与前一节的额外间距。 */
export interface SkinNode {
  readonly distance: number;
  readonly frameTime: number;
  readonly textures: ReadonlyArray<string>;
}

export interface SkinAtlasInfo {
  readonly path: string;
  readonly width: number;
  readonly height: number;
}

/** 一套内置皮肤；字段与官方 `SkinTextures` 一一对应。 */
export interface InternalSkin {
  readonly id: number;
  readonly atlas: SkinAtlasInfo;
  /** `GameUtil.calSkinSizeInfo` 的皮肤显示宽率。 */
  readonly bodyRenderWidthRate: number;
  /** 头部与第一节身体之间的额外间距。 */
  readonly bodyDistance: number;
  /** 身体首帧的代表色，供死亡粒子等非贴图特效使用。 */
  readonly bodyColor: number;
  readonly frames: Readonly<Record<string, SkinFrame>>;
  readonly head: SkinNode;
  readonly headSpeed: SkinNode | null;
  /** 身体按 level 分档的帧组，顺序即原版数组顺序。 */
  readonly body: ReadonlyArray<SkinNode>;
  readonly bodySpeed: ReadonlyArray<SkinNode>;
  readonly tail: SkinNode | null;
  readonly tailSpeed: SkinNode | null;
}

export interface InternalSkinSource {
  readonly bundle: string;
  readonly configVersion: string;
  readonly archiveVersion: string;
}

interface InternalSkinManifest {
  readonly source: InternalSkinSource;
  readonly defaultSkinId: number;
  readonly skins: ReadonlyArray<InternalSkin>;
}

/**
 * 生成清单的唯一类型边界。
 *
 * 每套皮肤的帧名各不相同，TypeScript 会把 JSON 的 `frames` 推断成一组互不兼容的
 * 具名字段，无法直接匹配 `Record<string, SkinFrame>`，所以在这里一次性收敛。
 * 字段完整性由同目录的清单测试逐项校验。
 */
const SKIN_MANIFEST = manifest as unknown as InternalSkinManifest;

/** 官方 `internalSkins` bundle 的来源信息，便于核对资源版本。 */
export const INTERNAL_SKIN_SOURCE: InternalSkinSource = SKIN_MANIFEST.source;

/** 从内置皮肤 bundle 整理出的全部皮肤。 */
export const INTERNAL_SKINS: ReadonlyArray<InternalSkin> = SKIN_MANIFEST.skins;

/** `Constant.internalSkinIds`：清单自带的皮肤 ID，不在代码里枚举。 */
export const INTERNAL_SKIN_IDS: ReadonlyArray<number> = INTERNAL_SKINS.map((skin) => skin.id);

/** `Constant.defaultSkinId`：未选择皮肤时的官方默认皮肤。 */
export const DEFAULT_SKIN_ID: number = manifest.defaultSkinId;

const SKIN_BY_ID = new Map<number, InternalSkin>(INTERNAL_SKINS.map((skin) => [skin.id, skin]));

export function internalSkin(skinId: number): InternalSkin | undefined {
  return SKIN_BY_ID.get(skinId);
}

export function isInternalSkinId(skinId: unknown): skinId is number {
  return typeof skinId === "number" && SKIN_BY_ID.has(skinId);
}

/** 皮肤缺失时回落到官方默认皮肤，与原版 `loadMySnakeSkinTextures` 一致。 */
export function internalSkinOrDefault(skinId: number): InternalSkin {
  const skin = SKIN_BY_ID.get(skinId) ?? SKIN_BY_ID.get(DEFAULT_SKIN_ID);
  if (skin === undefined) throw new Error("Internal skin manifest is empty");
  return skin;
}

export function skinFrame(skin: InternalSkin, name: string): SkinFrame {
  const frame = skin.frames[name];
  if (frame === undefined) throw new Error(`Skin ${skin.id} has no frame ${name}`);
  return frame;
}

/**
 * 原版 SnakeGLNode 的 quad 尺寸由普通基准帧决定，切换加速/动画纹理只替换 UV。
 * Pixi Sprite 会默认随当前纹理尺寸改变几何，因此必须分别反算 X/Y 缩放。
 */
export function fixedSkinFrameScale(
  renderWidth: number,
  renderHeight: number,
  textureWidth: number,
  textureHeight: number,
): { readonly x: number; readonly y: number } {
  return {
    x: renderWidth / Math.max(1, textureWidth),
    y: renderHeight / Math.max(1, textureHeight),
  };
}

/** 原版 `SkinSizeInfo` 中渲染实际用到的部分。 */
export interface SkinSizeInfo {
  /** 贴图到世界单位的统一缩放，原版记作 `scale`。 */
  readonly scale: number;
  /** 该体型档位下的采样点间距。 */
  readonly pointDistance: number;
  readonly bodyWidth: number;
  readonly bodyHeight: number;
  readonly headWidth: number;
  readonly headHeight: number;
  readonly tailWidth: number;
  readonly tailHeight: number;
  /** 头部到第一节身体之间跨越的采样点数。 */
  readonly bodyPointFirstDistance: number;
  /** 相邻身体节之间跨越的采样点数。 */
  readonly bodyPointDistance: number;
  /** 尾巴相对最后一节身体后移的采样点数。 */
  readonly tailPointDistance: number;
}

/** `POINT_DIS * (1 + (bodyScale - 1) / 5)`：体型越大，节间距同步放大。 */
export function skinPointDistance(bodyScale: number): number {
  return SNAKE_MOTION.pointSpacing * (1 + (bodyScale - 1) / 5);
}

/**
 * 复刻 `GameUtil.calSkinSizeInfo` 的 `NormalRepeat` 分支。
 *
 * 缩放以身体首帧宽度对齐 `SNAKE_BODY_WIDTH`，因此不同皮肤即使贴图尺寸不同，
 * 世界里的身体宽度仍然一致。
 */
export function skinSizeInfo(skin: InternalSkin, bodyScale: number): SkinSizeInfo {
  const pointDistance = skinPointDistance(bodyScale);
  const bodyFrame = skinFrame(skin, skin.body[0].textures[0]);
  const headFrame = skinFrame(skin, skin.head.textures[0]);
  const scale = (SNAKE_BODY.width * skin.bodyRenderWidthRate * bodyScale) / bodyFrame.width;

  const bodyWidth = bodyFrame.width * scale;
  const bodyHeight = bodyFrame.height * scale;
  const headWidth = headFrame.width * scale;
  const headHeight = headFrame.height * scale;

  const tailFrame = skin.tail === null ? undefined : skinFrame(skin, skin.tail.textures[0]);
  const tailWidth = tailFrame === undefined ? 0 : tailFrame.width * scale;
  const tailHeight = tailFrame === undefined ? 0 : tailFrame.height * scale;

  return {
    scale,
    pointDistance,
    bodyWidth,
    bodyHeight,
    headWidth,
    headHeight,
    tailWidth,
    tailHeight,
    bodyPointFirstDistance: Math.round(
      (0.5 * headHeight + 0.5 * bodyHeight + skin.bodyDistance * scale) / pointDistance,
    ),
    bodyPointDistance: Math.round((bodyHeight + skin.body[0].distance * scale) / pointDistance),
    tailPointDistance:
      skin.tail === null
        ? 0
        : Math.round(
            (0.5 * bodyHeight + 0.5 * tailHeight + skin.tail.distance * scale) / pointDistance,
          ),
  };
}

/**
 * 复刻 `GameUtil.calBodyPointIndexs` 的 `NormalRepeat` 分支。
 *
 * 返回身体节在采样点数组中的下标，索引 0 是头部。
 * 头部与第一节之间使用 `bodyPointFirstDistance`，之后按 `bodyPointDistance` 等距铺开。
 */
export function bodyPointIndexes(size: SkinSizeInfo, pointCount: number): Array<number> {
  const indexes: Array<number> = [0];
  if (pointCount <= 0) return indexes;

  let remaining = pointCount;
  const first = size.bodyPointFirstDistance;
  if (remaining > first) {
    indexes.push(Math.max(0, indexes[indexes.length - 1] + first));
    remaining -= first;
  }

  const stride = size.bodyPointDistance;
  if (stride <= 0) return indexes;
  while (remaining > stride) {
    const next = indexes[indexes.length - 1] + stride;
    if (pointCount <= next) break;
    indexes.push(next);
    remaining -= stride;
  }
  return indexes;
}

/**
 * 复刻 `SkinNode.getTexture`：帧号按首帧时长整除后再对帧数取模。
 *
 * `frameCount` 是同一状态（加速或非加速）已连续经过的 60 Hz 源帧数。
 */
export function nodeFrameName(node: SkinNode, frameCount: number): string {
  if (node.textures.length === 0) throw new Error("Skin node has no textures");
  const normalizedFrameCount = Number.isFinite(frameCount) ? Math.max(0, frameCount) : 0;
  const index = Math.floor(normalizedFrameCount / node.frameTime) % node.textures.length;
  return node.textures[index];
}

/**
 * 身体节使用的帧组：`(渲染下标 - 1) % 帧组数`。
 *
 * 原版按这个式子在多个 level 的身体帧之间交替，从而形成条纹或渐变。
 */
export function bodyNodeAt(nodes: ReadonlyArray<SkinNode>, renderIndex: number): SkinNode {
  return nodes[(renderIndex - 1) % nodes.length];
}
