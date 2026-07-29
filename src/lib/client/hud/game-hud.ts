import { MAP_BORDER } from "$lib/game/arena";
import type { Point, SnakeSnapshot } from "$lib/protocol/state";

export interface HudRankEntry {
  readonly playerId: string;
  readonly nickname: string;
  readonly rank: number;
  readonly score: number;
  readonly kills: number;
}

export interface GameMapMarker {
  readonly playerId: string;
  readonly kind: "top" | "me";
  /** 榜首标记的实际名次；本机标记不携带名次。 */
  readonly rank?: number;
  readonly position: Point;
}

export interface GameMapPoint {
  readonly left: number;
  readonly top: number;
}

/**
 * 正常新无尽按分数排名。JavaScript 稳定排序会在同分时保留权威快照顺序，
 * 与原版只比较 `score` 的排序器一致。
 */
export function rankAliveSnakes(snakes: ReadonlyArray<SnakeSnapshot>): Array<HudRankEntry> {
  return snakes
    .filter((snake) => snake.alive)
    .sort((left, right) => right.score - left.score)
    .map((snake, index) => ({
      playerId: snake.id,
      nickname: snake.nickname,
      rank: index + 1,
      score: Math.round(snake.score),
      kills: snake.kills,
    }));
}

/** 原版前十规则：本机在前十外时，用本机真实名次替换第十行。 */
export function visibleHudRanks(
  ranked: ReadonlyArray<HudRankEntry>,
  selfId: string | undefined,
): Array<HudRankEntry> {
  const visible = ranked.slice(0, 10);
  if (selfId === undefined) return visible;

  const self = ranked.find((entry) => entry.playerId === selfId);
  if (self === undefined || self.rank <= 10 || visible.length < 10) return visible;
  return [...visible.slice(0, 9), self];
}

/**
 * 正常新无尽小地图只保留一个领先目标和本机。
 * 本机已经第一时，领先目标顺延为第二名，避免两个图标完全重叠后失去参照。
 */
export function selectGameMapMarkers(
  ranked: ReadonlyArray<HudRankEntry>,
  snakes: ReadonlyArray<SnakeSnapshot>,
  selfId: string | undefined,
): Array<GameMapMarker> {
  const snakesById = new Map(snakes.map((snake) => [snake.id, snake]));
  const selfRank = ranked.find((entry) => entry.playerId === selfId)?.rank;
  const target = selfRank === 1 ? ranked[1] : ranked[0];
  const markers: Array<GameMapMarker> = [];

  if (target !== undefined) {
    const snake = snakesById.get(target.playerId);
    const head = snake?.alive ? snake.body[0] : undefined;
    if (head !== undefined) {
      markers.push({
        playerId: target.playerId,
        kind: "top",
        rank: target.rank,
        position: head,
      });
    }
  }

  if (selfId !== undefined) {
    const snake = snakesById.get(selfId);
    const head = snake?.alive ? snake.body[0] : undefined;
    if (head !== undefined) markers.push({ playerId: selfId, kind: "me", position: head });
  }

  return markers;
}

/**
 * 将游戏世界坐标映射到小地图坐标；游戏与 DOM 都以 Y 向下为正，不额外翻转。
 * 地图使用剔除 16 世界单位边界后的矩形；本机可钳边，其他标记越界隐藏。
 */
export function projectGameMapPoint(
  position: Point,
  arenaHalfSize: number,
  clampToEdge: boolean,
  mapSize = 160,
): GameMapPoint | undefined {
  const halfRange = arenaHalfSize - MAP_BORDER;
  if (halfRange <= 0) return undefined;

  const outside =
    position.x < -halfRange ||
    position.x > halfRange ||
    position.y < -halfRange ||
    position.y > halfRange;
  if (outside && !clampToEdge) return undefined;

  const x = Math.min(halfRange, Math.max(-halfRange, position.x));
  const y = Math.min(halfRange, Math.max(-halfRange, position.y));
  return {
    left: ((x + halfRange) / (halfRange * 2)) * mapSize,
    top: ((y + halfRange) / (halfRange * 2)) * mapSize,
  };
}

/** 原版普通地图网络状态阈值：70ms 绿，90ms 黄，更高为红。 */
export function netStatusColor(pingMs: number): string {
  if (pingMs <= 70) return "rgb(5 199 13)";
  if (pingMs <= 90) return "rgb(255 172 0)";
  return "rgb(255 87 88)";
}
