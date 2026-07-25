export interface SkinDefinition {
  readonly id: string;
  readonly body: number;
  readonly dark: number;
  readonly light: number;
}

export const SKINS: ReadonlyArray<SkinDefinition> = [
  { id: "green", body: 0x86d94e, dark: 0x4c9a33, light: 0xd0f5a8 },
  { id: "blue", body: 0x4db8f0, dark: 0x2a6fb8, light: 0xb3e2fa },
  { id: "purple", body: 0xa86ef0, dark: 0x6a3ab8, light: 0xdcc4fa },
  { id: "orange", body: 0xf5a53c, dark: 0xc06a1d, light: 0xfad6a0 },
  { id: "red", body: 0xf26d5f, dark: 0xb83a2e, light: 0xfabcb3 },
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
  border: 0x3ddc84,
  danger: 0xf26d5f,
} as const;
