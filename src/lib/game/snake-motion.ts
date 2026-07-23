export interface MotionPoint {
  x: number;
  y: number;
}

export interface SnakeMotionState {
  body: Array<MotionPoint>;
  angle: number;
  targetAngle: number;
  length: number;
  boosting: boolean;
}

export interface SnakeMotionRules {
  baseSpeed: number;
  boostSpeed: number;
  turnRate: number;
  minimumLength: number;
  boostMinimumLength: number;
  boostDrainPerSecond: number;
}

const TAU = Math.PI * 2;

export function normalizeAngle(angle: number): number {
  const normalized = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return normalized === -Math.PI ? Math.PI : normalized;
}

export function turnTowards(current: number, target: number, maximumTurn: number): number {
  const difference = normalizeAngle(target - current);
  if (Math.abs(difference) <= maximumTurn) return normalizeAngle(target);
  return normalizeAngle(current + Math.sign(difference) * maximumTurn);
}

/** Advances one authoritative game tick and returns the length drained by boost. */
export function advanceSnakeMotion(
  state: SnakeMotionState,
  rules: SnakeMotionRules,
  secondsPerTick: number,
): number {
  state.angle = turnTowards(state.angle, state.targetAngle, rules.turnRate * secondsPerTick);
  const canBoost = state.boosting && state.length > rules.boostMinimumLength;
  const speed = canBoost ? rules.boostSpeed : rules.baseSpeed;
  const head = {
    x: state.body[0].x + Math.cos(state.angle) * speed * secondsPerTick,
    y: state.body[0].y + Math.sin(state.angle) * speed * secondsPerTick,
  };
  state.body.unshift(head);

  let drained = 0;
  if (canBoost) {
    drained = Math.min(
      rules.boostDrainPerSecond * secondsPerTick,
      state.length - rules.minimumLength,
    );
    state.length -= drained;
  }
  trimBody(state.body, state.length);
  return drained;
}

export function trimBody(body: Array<MotionPoint>, length: number): void {
  let accumulated = 0;
  for (let index = 1; index < body.length; index += 1) {
    const previous = body[index - 1];
    const current = body[index];
    const segmentLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (accumulated + segmentLength < length) {
      accumulated += segmentLength;
      continue;
    }
    const remaining = Math.max(0, length - accumulated);
    const ratio = segmentLength === 0 ? 0 : remaining / segmentLength;
    body[index] = {
      x: previous.x + (current.x - previous.x) * ratio,
      y: previous.y + (current.y - previous.y) * ratio,
    };
    body.splice(index + 1);
    return;
  }
}
