/**
 * 客户端静态配置：皮肤注册表、渲染常量、资产路径。
 * 只存放常量，不包含任何行为逻辑。
 */

export interface SkinDefinition {
  readonly id: string;
  /** 身体主色 */
  readonly body: number;
  /** 描边/暗部色 */
  readonly dark: number;
  /** 高光色 */
  readonly light: number;
  /** 小地图点色 */
  readonly minimap: string;
  readonly headTexture: string;
}

export const SKINS: ReadonlyArray<SkinDefinition> = [
  {
    id: "green",
    body: 0x86d94e,
    dark: 0x4c9a33,
    light: 0xd0f5a8,
    minimap: "#86d94e",
    headTexture: "/assets/sprites/head-green.png",
  },
  {
    id: "blue",
    body: 0x4db8f0,
    dark: 0x2a6fb8,
    light: 0xb3e2fa,
    minimap: "#4db8f0",
    headTexture: "/assets/sprites/head-blue.png",
  },
  {
    id: "purple",
    body: 0xa86ef0,
    dark: 0x6a3ab8,
    light: 0xdcc4fa,
    minimap: "#a86ef0",
    headTexture: "/assets/sprites/head-purple.png",
  },
  {
    id: "orange",
    body: 0xf5a53c,
    dark: 0xc06a1d,
    light: 0xfad6a0,
    minimap: "#f5a53c",
    headTexture: "/assets/sprites/head-orange.png",
  },
  {
    id: "red",
    body: 0xf26d5f,
    dark: 0xb83a2e,
    light: 0xfabcb3,
    minimap: "#f26d5f",
    headTexture: "/assets/sprites/head-red.png",
  },
];

/** 由 playerId 稳定推导皮肤，保证所有客户端看到的一致。 */
export function skinForPlayer(playerId: string): SkinDefinition {
  let hash = 0;
  for (let index = 0; index < playerId.length; index += 1) {
    hash = (hash * 31 + playerId.charCodeAt(index)) | 0;
  }
  return SKINS[Math.abs(hash) % SKINS.length];
}

export const ASSET_PATHS = {
  bgTile: "/assets/art/bg-tile.webp",
  logo: "/assets/art/logo.png",
  loginHero: "/assets/art/login-hero.webp",
  foodPearl: "/assets/sprites/food-pearl.png",
  foodGold: "/assets/sprites/food-gold.png",
} as const;

export const RENDER = {
  /** 插值延迟相对快照间隔的倍率 */
  interpolationDelayFactor: 1.4,
  minInterpolationDelayMs: 90,
  maxInterpolationDelayMs: 260,
  maxDevicePixelRatio: 2,
  /** 相机缩放随蛇半径变化 */
  zoomAtBaseRadius: 1.45,
  zoomAtMaxRadius: 0.78,
  cameraLerp: 0.12,
} as const;

export const INPUT = {
  sendIntervalMs: 33,
  angleEpsilon: 0.02,
  pingIntervalMs: 5_000,
} as const;

export const ARENA_COLORS = {
  border: 0x3ddc84,
  borderGlow: 0x1d5c3a,
  danger: 0xf26d5f,
} as const;
