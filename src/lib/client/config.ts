/** 按序号生成同一组资源的路径，避免逐条手写。 */
function numberedPaths(directory: string, prefix: string, count: number): ReadonlyArray<string> {
  return Array.from({ length: count }, (_, index) => `${directory}/${prefix}-${index + 1}.png`);
}

export const ASSET_PATHS = {
  effects: {
    speedUp: "/assets/art/effects/speed-up.png",
    protect: "/assets/art/effects/protect.png",
    magnet: [
      "/assets/art/effects/magnet/ring.png",
      "/assets/art/effects/magnet/light-1.png",
      "/assets/art/effects/magnet/light-2.png",
      "/assets/art/effects/magnet/light-3.png",
      "/assets/art/effects/magnet/particle.png",
    ],
  },
  tools: {
    magnet: "/assets/art/tools/magnet.png",
    statusBackground: "/assets/art/tools/tool-bg.png",
    statusMask: "/assets/art/tools/tool-mask.png",
  },
  food: {
    dots: numberedPaths("/assets/art/food", "dot", 7),
    star: "/assets/art/food/star.png",
  },
  /** 残骸贴图：加速掉落与死亡残骸共用这一组糖果帧。 */
  wrecks: numberedPaths("/assets/art/wrecks", "candy", 20),
} as const;

export const RENDER = {
  interpolationDelayFactor: 1.4,
  minInterpolationDelayMs: 90,
  maxInterpolationDelayMs: 260,
  maxDevicePixelRatio: 2,
  /**
   * 固定设计分辨率。
   *
   * 原版正常 `Game` 使用 Cocos `FIXED_HEIGHT`：世界单位先按 `高/750`
   * 折算到设计像素，再乘相机缩放。宽高比只改变左右可见范围。
   */
  designWidth: 1334,
  designHeight: 750,
  /** 相机缩放：出生 1.3，长度达到 cameraScaleMaxLength 时降到 0.6。 */
  cameraInitScale: 1.3,
  cameraMinScale: 0.6,
  cameraScaleMaxLength: 100_000,
} as const;

export const INPUT = {
  angleEpsilon: 0.02,
  pingIntervalMs: 5_000,
} as const;

export const ARENA_COLORS = {
  /** 场外底色。 */
  surround: 0x6c241f,
  /** 场地底色。 */
  floor: 0xebecf4,
  /** 网格线。 */
  grid: 0xcdcdd6,
  /** 场地边框。 */
  border: 0xeb4f71,
} as const;

/** 场地几何：网格间距、边框宽度与外扩量。 */
export const ARENA_GEOMETRY = {
  gridSpacing: 32,
  gridLineWidth: 1,
  borderWidth: 4,
  borderOutset: 2,
} as const;
