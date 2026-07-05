import { BaseEdge } from '@xyflow/react';
import { BASE_TURN, LANE_STEP } from './graph.js';

/** A strictly orthogonal trace: out of the source, one turn, one turn back into the target.
 * `lane` staggers how far it runs before the first turn so parallel lines don't overlap. */
export function CircuitEdge({ sourceX, sourceY, targetX, targetY, style, data }) {
  const lane = data?.lane ?? 0;
  const dir = targetX >= sourceX ? 1 : -1;
  const turnX = sourceX + dir * (BASE_TURN + lane * LANE_STEP);
  const path = `M ${sourceX},${sourceY} H ${turnX} V ${targetY} H ${targetX}`;
  return <BaseEdge path={path} style={style} />;
}

export const edgeTypes = {
  circuit: CircuitEdge,
};
