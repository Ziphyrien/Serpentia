export interface CollectibleAbsorbPoint {
  readonly x: number;
  readonly y: number;
}

export interface CollectibleAbsorbState {
  readonly source: CollectibleAbsorbPoint;
  readonly target: CollectibleAbsorbPoint;
  readonly delta: CollectibleAbsorbPoint;
  readonly startedAtSourceFrame: number;
  readonly sourceFrameCount: number;
}

export interface CollectibleAbsorbSample {
  readonly position: CollectibleAbsorbPoint;
  readonly completedSourceFrames: number;
  readonly started: boolean;
  readonly complete: boolean;
}

export interface CollectibleAbsorbTrackingState {
  readonly position: CollectibleAbsorbPoint;
  readonly target: CollectibleAbsorbPoint;
  readonly completedSourceFrames: number;
  readonly startedAtSourceFrame: number;
  readonly sourceFrameCount: number;
}

export interface CollectibleAbsorbTrackingSample extends CollectibleAbsorbSample {
  readonly state: CollectibleAbsorbTrackingState;
}

const SOURCE_FRAME_EPSILON = 0.000_001;

export function createCollectibleAbsorbState(
  source: CollectibleAbsorbPoint,
  target: CollectibleAbsorbPoint,
  startedAtSourceFrame: number,
  sourceFrameCount: number,
): CollectibleAbsorbState {
  const normalizedSourceFrameCount = normalizeSourceFrameCount(sourceFrameCount);
  return {
    source: { x: source.x, y: source.y },
    target: { x: target.x, y: target.y },
    delta: {
      x: (target.x - source.x) / normalizedSourceFrameCount,
      y: (target.y - source.y) / normalizedSourceFrameCount,
    },
    startedAtSourceFrame,
    sourceFrameCount: normalizedSourceFrameCount,
  };
}

export function sampleCollectibleAbsorbState(
  state: CollectibleAbsorbState,
  presentationSourceFrame: number,
): CollectibleAbsorbSample {
  const completedSourceFrames = completedFrames(
    presentationSourceFrame,
    state.startedAtSourceFrame,
    state.sourceFrameCount,
  );

  let x = state.source.x;
  let y = state.source.y;
  for (let frame = 0; frame < completedSourceFrames; frame += 1) {
    x += state.delta.x;
    y += state.delta.y;
  }

  return sample(
    { x, y },
    completedSourceFrames,
    state.sourceFrameCount,
    presentationSourceFrame,
    state.startedAtSourceFrame,
  );
}

export function createCollectibleAbsorbTrackingState(
  source: CollectibleAbsorbPoint,
  target: CollectibleAbsorbPoint,
  startedAtSourceFrame: number,
  sourceFrameCount: number,
): CollectibleAbsorbTrackingState {
  return {
    position: { x: source.x, y: source.y },
    target: { x: target.x, y: target.y },
    completedSourceFrames: 0,
    startedAtSourceFrame,
    sourceFrameCount: normalizeSourceFrameCount(sourceFrameCount),
  };
}

export function advanceCollectibleAbsorbTrackingState(
  state: CollectibleAbsorbTrackingState,
  presentationSourceFrame: number,
  target: CollectibleAbsorbPoint,
): CollectibleAbsorbTrackingSample {
  const desiredSourceFrames = completedFrames(
    presentationSourceFrame,
    state.startedAtSourceFrame,
    state.sourceFrameCount,
  );
  let x = state.position.x;
  let y = state.position.y;
  let completedSourceFrames = state.completedSourceFrames;
  while (completedSourceFrames < desiredSourceFrames) {
    const remainingSourceFrames = state.sourceFrameCount - completedSourceFrames;
    x += (target.x - x) / remainingSourceFrames;
    y += (target.y - y) / remainingSourceFrames;
    completedSourceFrames += 1;
  }

  const nextState: CollectibleAbsorbTrackingState = {
    position: { x, y },
    target: { x: target.x, y: target.y },
    completedSourceFrames,
    startedAtSourceFrame: state.startedAtSourceFrame,
    sourceFrameCount: state.sourceFrameCount,
  };
  return {
    ...sample(
      nextState.position,
      completedSourceFrames,
      state.sourceFrameCount,
      presentationSourceFrame,
      state.startedAtSourceFrame,
    ),
    state: nextState,
  };
}

function completedFrames(
  presentationSourceFrame: number,
  startedAtSourceFrame: number,
  sourceFrameCount: number,
): number {
  const elapsed = presentationSourceFrame - startedAtSourceFrame;
  return Number.isFinite(elapsed) && elapsed + SOURCE_FRAME_EPSILON >= 0
    ? Math.min(sourceFrameCount, Math.max(0, Math.floor(elapsed + SOURCE_FRAME_EPSILON)))
    : 0;
}

function sample(
  position: CollectibleAbsorbPoint,
  completedSourceFrames: number,
  sourceFrameCount: number,
  presentationSourceFrame: number,
  startedAtSourceFrame: number,
): CollectibleAbsorbSample {
  const elapsed = presentationSourceFrame - startedAtSourceFrame;
  return {
    position,
    completedSourceFrames,
    started: Number.isFinite(elapsed) && elapsed + SOURCE_FRAME_EPSILON >= 0,
    complete: completedSourceFrames >= sourceFrameCount,
  };
}

function normalizeSourceFrameCount(sourceFrameCount: number): number {
  return Number.isFinite(sourceFrameCount) ? Math.max(1, Math.floor(sourceFrameCount)) : 1;
}
