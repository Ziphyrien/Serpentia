import { normalizeAngle } from "../../game/snake-motion";
import type { InputState } from "./input-state";

export interface SentInputState {
  readonly angle: number | undefined;
  readonly boosting: boolean;
}

export interface NetworkInputCommand {
  readonly angle: number;
  readonly boosting: boolean;
}

/** Resolves a sendable command without inventing an east-facing default angle. */
export function nextNetworkInput(
  input: Pick<InputState, "angle" | "boosting" | "hasDirection">,
  authoritativeAngle: number | undefined,
  lastSent: SentInputState,
  angleEpsilon: number,
): NetworkInputCommand | undefined {
  const angle = input.hasDirection ? input.angle : authoritativeAngle;
  if (angle === undefined) return undefined;

  const boostChanged = input.boosting !== lastSent.boosting;
  if (!input.hasDirection && !boostChanged) return undefined;
  const angleChanged =
    lastSent.angle === undefined || Math.abs(normalizeAngle(angle - lastSent.angle)) > angleEpsilon;
  if (!angleChanged && !boostChanged) return undefined;
  return { angle, boosting: input.boosting };
}
