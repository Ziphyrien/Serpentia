import {
  SNAKE_MOTION,
  normalizeAngle,
  quantizeSnakeTargetAngle,
  snakeBodyRadius,
  snakeCollisionDistance,
  turnTowards,
} from "$lib/game/snake-motion";
import type { FoodState, GameSnapshot, Point, SnakeSnapshot } from "$lib/protocol";

const PREDICTION_FRAMES = 72;
const FRAME_DISTANCE = SNAKE_MOTION.pointSpacing * SNAKE_MOTION.pointsPerFrame;
const PREDICTION_DISTANCE = PREDICTION_FRAMES * FRAME_DISTANCE;
const FOOD_SEARCH_DISTANCE = 1_400;
const FOOD_BOUNDARY_MARGIN = 560;
const CENTER_RETURN_CLEARANCE = 720;
const OBSTACLE_BUFFER = 80;
const MAX_OBSTACLE_SEGMENTS_PER_SNAKE = 90;
const MAX_CLEARANCE = 1_200;
const SAFETY_BUCKET_SIZE = 40;
const SWITCH_SAFETY_TOLERANCE = 50;
const SWITCH_UTILITY_ADVANTAGE = 70;
const PATROL_REACHED_DISTANCE = 160;

const CANDIDATE_OFFSETS: ReadonlyArray<number> = [
  -Math.PI,
  (-3 * Math.PI) / 4,
  -Math.PI / 2,
  -Math.PI / 3,
  -Math.PI / 4,
  -Math.PI / 6,
  0,
  Math.PI / 6,
  Math.PI / 4,
  Math.PI / 3,
  Math.PI / 2,
  (3 * Math.PI) / 4,
  Math.PI,
];

export interface MenuAutopilotCommand {
  readonly angle: number;
  readonly boosting: false;
}

interface ObstacleSegment {
  readonly start: Point;
  readonly end: Point;
  readonly collisionDistance: number;
  readonly velocity?: Point;
}

interface TrajectoryEvaluation {
  readonly angle: number;
  readonly survivedFrames: number;
  readonly minimumSafety: number;
  readonly utility: number;
}

/**
 * Receding-horizon DWA/MPC driver used while an in-game menu is open.
 *
 * Each snapshot samples target headings, rolls the exact 60 Hz turn/movement model forward for
 * 1.2 seconds, rejects trajectories that hit the border or another snake, and executes only the
 * selected heading until the next snapshot. No static grid or global path is involved.
 */
export class MenuAutopilot {
  private selectedAngle: number | undefined;
  private goalFoodId: number | undefined;
  private patrolTarget: Point | undefined;

  command(
    snapshot: GameSnapshot,
    selfId: string | undefined,
    arenaHalfSize: number,
  ): MenuAutopilotCommand | undefined {
    const self = selfId === undefined ? undefined : snapshot.snakes.find((snake) => snake.id === selfId);
    const head = self?.body[0];
    if (self === undefined || head === undefined || !self.alive || arenaHalfSize <= 0) {
      this.reset();
      return undefined;
    }

    const goal = this.selectGoal(snapshot.foods, self, arenaHalfSize);
    const goalAngle = Math.atan2(goal.y - head.y, goal.x - head.x);
    const obstacles = obstacleSegments(snapshot.snakes, self);
    const candidates = candidateAngles(self, goalAngle, this.selectedAngle);
    const evaluations = candidates.map((angle) =>
      evaluateTrajectory(angle, self, goal, obstacles, arenaHalfSize, this.selectedAngle),
    );
    const best = bestTrajectory(evaluations);
    if (best === undefined) return undefined;

    const previous =
      this.selectedAngle === undefined
        ? undefined
        : evaluations.find((evaluation) => sameAngle(evaluation.angle, this.selectedAngle));
    const selected =
      previous !== undefined && shouldRetainPrevious(previous, best) ? previous : best;
    this.selectedAngle = selected.angle;
    return { angle: selected.angle, boosting: false };
  }

  reset(): void {
    this.selectedAngle = undefined;
    this.goalFoodId = undefined;
    this.patrolTarget = undefined;
  }

  private selectGoal(
    foods: ReadonlyArray<FoodState>,
    self: SnakeSnapshot,
    arenaHalfSize: number,
  ): Point {
    const head = self.body[0] ?? { x: 0, y: 0 };
    const boundaryClearance = arenaHalfSize - Math.max(Math.abs(head.x), Math.abs(head.y));
    if (boundaryClearance < CENTER_RETURN_CLEARANCE) {
      this.goalFoodId = undefined;
      this.patrolTarget = undefined;
      return { x: 0, y: 0 };
    }

    const retained =
      this.goalFoodId === undefined ? undefined : foods.find((food) => food.id === this.goalFoodId);
    if (retained !== undefined && isSafeFood(retained, head, arenaHalfSize)) {
      return retained.position;
    }

    let bestFood: FoodState | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const food of foods) {
      if (!isSafeFood(food, head, arenaHalfSize)) continue;
      const foodDistance = distance(head, food.position);
      const score = Math.max(1, food.value) / Math.max(80, foodDistance);
      if (score > bestScore) {
        bestFood = food;
        bestScore = score;
      }
    }
    if (bestFood !== undefined) {
      this.goalFoodId = bestFood.id;
      this.patrolTarget = undefined;
      return bestFood.position;
    }

    this.goalFoodId = undefined;
    if (
      this.patrolTarget === undefined ||
      distance(head, this.patrolTarget) < PATROL_REACHED_DISTANCE
    ) {
      this.patrolTarget = patrolTarget(head, self.targetAngle ?? self.angle, arenaHalfSize);
    }
    return this.patrolTarget;
  }
}

/** One-shot helper retained for focused behavior probes. */
export function menuAutopilotCommand(
  snapshot: GameSnapshot,
  selfId: string | undefined,
  arenaHalfSize: number,
): MenuAutopilotCommand | undefined {
  return new MenuAutopilot().command(snapshot, selfId, arenaHalfSize);
}

function candidateAngles(
  self: SnakeSnapshot,
  goalAngle: number,
  previousAngle: number | undefined,
): Array<number> {
  const current = self.targetAngle ?? self.angle;
  return uniqueAngles([
    ...CANDIDATE_OFFSETS.map((offset) => current + offset),
    goalAngle,
    Math.atan2(-(self.body[0]?.y ?? 0), -(self.body[0]?.x ?? 0)),
    ...(previousAngle === undefined ? [] : [previousAngle]),
  ]);
}

function uniqueAngles(values: ReadonlyArray<number>): Array<number> {
  const seen = new Set<number>();
  const result: Array<number> = [];
  for (const value of values) {
    const angle = quantizeSnakeTargetAngle(normalizeAngle(value));
    const key = Math.round(angle * 100_000);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(angle);
  }
  return result;
}

function evaluateTrajectory(
  targetAngle: number,
  self: SnakeSnapshot,
  goal: Point,
  obstacles: ReadonlyArray<ObstacleSegment>,
  arenaHalfSize: number,
  previousAngle: number | undefined,
): TrajectoryEvaluation {
  const head = self.body[0] ?? { x: 0, y: 0 };
  const startGoalDistance = distance(head, goal);
  const bodyRadius = snakeBodyRadius(self.bodyScale);
  let x = head.x;
  let y = head.y;
  let heading = self.angle;
  let survivedFrames = 0;
  let minimumBoundary = MAX_CLEARANCE;
  let minimumObstacle = MAX_CLEARANCE;

  for (let frame = 0; frame < PREDICTION_FRAMES; frame += 1) {
    heading = turnTowards(heading, targetAngle, SNAKE_MOTION.turnPerFrame);
    x += Math.cos(heading) * FRAME_DISTANCE;
    y += Math.sin(heading) * FRAME_DISTANCE;

    const boundaryClearance =
      arenaHalfSize - bodyRadius - Math.max(Math.abs(x), Math.abs(y));
    minimumBoundary = Math.min(minimumBoundary, boundaryClearance);
    if (boundaryClearance <= 0) break;

    // The safety buffer is much larger than one frame of travel, so checking every other frame
    // preserves collision coverage while keeping the 10 Hz planner inexpensive.
    if (frame % 2 === 0) {
      const obstacleClearance = minimumObstacleClearance({ x, y }, obstacles, frame + 1);
      minimumObstacle = Math.min(minimumObstacle, obstacleClearance);
      if (obstacleClearance <= 0) break;
    }
    survivedFrames = frame + 1;
  }

  const finalPoint = { x, y };
  const goalProgress = startGoalDistance - distance(finalPoint, goal);
  const goalAngle = Math.atan2(goal.y - head.y, goal.x - head.x);
  const alignment = Math.cos(normalizeAngle(targetAngle - goalAngle));
  const turnCost = Math.abs(normalizeAngle(targetAngle - (self.targetAngle ?? self.angle)));
  const continuityCost =
    previousAngle === undefined ? 0 : Math.abs(normalizeAngle(targetAngle - previousAngle));
  const minimumSafety = Math.min(minimumBoundary, minimumObstacle);
  const utility = goalProgress * 2 + alignment * 80 - turnCost * 18 - continuityCost * 12;

  return { angle: targetAngle, survivedFrames, minimumSafety, utility };
}

function bestTrajectory(
  evaluations: ReadonlyArray<TrajectoryEvaluation>,
): TrajectoryEvaluation | undefined {
  let best: TrajectoryEvaluation | undefined;
  for (const evaluation of evaluations) {
    if (best === undefined || isBetterTrajectory(evaluation, best)) best = evaluation;
  }
  return best;
}

function isBetterTrajectory(
  candidate: TrajectoryEvaluation,
  current: TrajectoryEvaluation,
): boolean {
  if (candidate.survivedFrames !== current.survivedFrames) {
    return candidate.survivedFrames > current.survivedFrames;
  }
  const candidateSafety = Math.floor(candidate.minimumSafety / SAFETY_BUCKET_SIZE);
  const currentSafety = Math.floor(current.minimumSafety / SAFETY_BUCKET_SIZE);
  if (candidateSafety !== currentSafety) return candidateSafety > currentSafety;
  return candidate.utility > current.utility;
}

function shouldRetainPrevious(
  previous: TrajectoryEvaluation,
  best: TrajectoryEvaluation,
): boolean {
  if (previous.survivedFrames < best.survivedFrames) return false;
  if (previous.minimumSafety + SWITCH_SAFETY_TOLERANCE < best.minimumSafety) return false;
  return best.utility - previous.utility < SWITCH_UTILITY_ADVANTAGE;
}

function obstacleSegments(
  snakes: ReadonlyArray<SnakeSnapshot>,
  self: SnakeSnapshot,
): Array<ObstacleSegment> {
  const segments: Array<ObstacleSegment> = [];
  const selfHead = self.body[0] ?? { x: 0, y: 0 };
  const nearbyDistance = PREDICTION_DISTANCE + MAX_CLEARANCE;
  const nearbyDistanceSquared = nearbyDistance * nearbyDistance;

  for (const snake of snakes) {
    if (snake.id === self.id || !snake.alive || snake.invulnerable || snake.body.length === 0) {
      continue;
    }
    const collisionDistance =
      snakeCollisionDistance(self.bodyScale, snake.bodyScale) + OBSTACLE_BUFFER;
    const segmentCount = Math.max(1, snake.body.length - 1);
    const stride = Math.max(1, Math.ceil(segmentCount / MAX_OBSTACLE_SEGMENTS_PER_SNAKE));
    for (let index = 0; index < snake.body.length - 1; index += stride) {
      const start = snake.body[index];
      const end = snake.body[Math.min(snake.body.length - 1, index + stride)];
      if (start === undefined || end === undefined) continue;
      if (pointToSegmentDistanceSquared(selfHead, start, end) > nearbyDistanceSquared) continue;
      segments.push({ start, end, collisionDistance });
    }

    const otherHead = snake.body[0];
    if (otherHead !== undefined) {
      const speed = FRAME_DISTANCE * (snake.boosting ? 2 : 1);
      segments.push({
        start: otherHead,
        end: otherHead,
        collisionDistance,
        velocity: {
          x: Math.cos(snake.angle) * speed,
          y: Math.sin(snake.angle) * speed,
        },
      });
    }
  }
  return segments;
}

function minimumObstacleClearance(
  point: Point,
  obstacles: ReadonlyArray<ObstacleSegment>,
  elapsedFrames: number,
): number {
  let clearance = MAX_CLEARANCE;
  for (const obstacle of obstacles) {
    const relativePoint =
      obstacle.velocity === undefined
        ? point
        : {
            x: point.x - obstacle.velocity.x * elapsedFrames,
            y: point.y - obstacle.velocity.y * elapsedFrames,
          };
    const segmentDistance = Math.sqrt(
      pointToSegmentDistanceSquared(relativePoint, obstacle.start, obstacle.end),
    );
    clearance = Math.min(clearance, segmentDistance - obstacle.collisionDistance);
  }
  return clearance;
}

function pointToSegmentDistanceSquared(point: Point, start: Point, end: Point): number {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (lengthSquared === 0) return distanceSquared(point, start);
  const projection = Math.min(
    1,
    Math.max(
      0,
      ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSquared,
    ),
  );
  const closest = {
    x: start.x + segmentX * projection,
    y: start.y + segmentY * projection,
  };
  return distanceSquared(point, closest);
}

function isSafeFood(food: FoodState, head: Point, arenaHalfSize: number): boolean {
  return (
    distance(head, food.position) <= FOOD_SEARCH_DISTANCE &&
    Math.max(Math.abs(food.position.x), Math.abs(food.position.y)) <=
      arenaHalfSize - FOOD_BOUNDARY_MARGIN
  );
}

function patrolTarget(head: Point, currentAngle: number, arenaHalfSize: number): Point {
  const radius = Math.max(300, (arenaHalfSize - CENTER_RETURN_CLEARANCE) * 0.55);
  const distanceFromCenter = Math.hypot(head.x, head.y);
  const targetAngle =
    distanceFromCenter < radius * 0.3
      ? currentAngle
      : Math.atan2(head.y, head.x) + Math.PI / 2;
  return { x: Math.cos(targetAngle) * radius, y: Math.sin(targetAngle) * radius };
}

function sameAngle(left: number, right: number | undefined): boolean {
  return right !== undefined && Math.abs(normalizeAngle(left - right)) < 0.001;
}

function distance(left: Point, right: Point): number {
  return Math.sqrt(distanceSquared(left, right));
}

function distanceSquared(left: Point, right: Point): number {
  const x = left.x - right.x;
  const y = left.y - right.y;
  return x * x + y * y;
}
