export interface SkinDefinition {
  readonly id: string;
  readonly textureIndex: number;
  /** 用于死亡粒子等非 Sprite 特效的代表色。 */
  readonly body: number;
}

/** Snake-Demo 游戏场景实际配置的四套蛇皮肤。 */
export const SKINS: ReadonlyArray<SkinDefinition> = [
  { id: "snake-demo-red", textureIndex: 0, body: 0xd71915 },
  { id: "snake-demo-blue", textureIndex: 1, body: 0x278fd0 },
  { id: "snake-demo-blue-alt", textureIndex: 2, body: 0x3190c7 },
  { id: "snake-demo-yellow", textureIndex: 3, body: 0xf1dc2e },
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
  snakeDemo: {
    arenaBackground: "/assets/art/snake-demo/arena-background.png",
    snakeSkins: [
      {
        head: "/assets/art/snake-demo/snake-1-head.png",
        body: "/assets/art/snake-demo/snake-1-body.png",
      },
      {
        head: "/assets/art/snake-demo/snake-2-head.png",
        body: "/assets/art/snake-demo/snake-2-body.png",
      },
      {
        head: "/assets/art/snake-demo/snake-3-head.png",
        body: "/assets/art/snake-demo/snake-3-body.png",
      },
      {
        head: "/assets/art/snake-demo/snake-4-head.png",
        body: "/assets/art/snake-demo/snake-4-body.png",
      },
    ],
    foods: [
      "/assets/art/snake-demo/food-1.png",
      "/assets/art/snake-demo/food-2.png",
      "/assets/art/snake-demo/food-3.png",
      "/assets/art/snake-demo/food-4.png",
      "/assets/art/snake-demo/food-5.png",
      "/assets/art/snake-demo/food-6.png",
      "/assets/art/snake-demo/food-7.png",
      "/assets/art/snake-demo/food-8.png",
    ],
    remainsFood: "/assets/art/snake-demo/food-remains.png",
  },
} as const;

export const RENDER = {
  interpolationDelayFactor: 1.4,
  minInterpolationDelayMs: 90,
  maxInterpolationDelayMs: 260,
  maxDevicePixelRatio: 2,
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
  /** 原版场地贴图外侧的纯红底图（Resources/bj.png）。 */
  outside: 0xed1c24,
  /** 原图加载失败时使用的主背景色。 */
  fallback: 0xebecf4,
} as const;
