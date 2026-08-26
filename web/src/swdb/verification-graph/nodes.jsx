import { Handle, Position } from '@xyflow/react';
import { AXES, AXIS_LETTER, AXIS_MARK, AXIS_STATUS_LABEL, statusVar } from './model.js';

const HANDLE_STYLE = { opacity: 0, width: 1, height: 1, border: 0, minWidth: 0, minHeight: 0 };

/**
 * One verification tick. Four sit in a statement card's header, one per axis:
 * filled = passed, hollow = not attempted, crossed = failed, dimmed = stale.
 */
function AxisTick({ axis, status, onSelect }) {
  const mark = AXIS_MARK[status] ?? 'hollow';
  return (
    <button
      type="button"
      className={`vg-tick vg-tick--${mark} nodrag nopan`}
      title={`${axis}: ${AXIS_STATUS_LABEL[status] ?? status}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(axis);
      }}
    >
      {AXIS_LETTER[axis]}
      {mark === 'crossed' ? <span className="vg-tick-cross" aria-hidden="true" /> : null}
    </button>
  );
}

/** A statement: a card whose header carries the four axis ticks and a status bar. */
export function StatementNode({ data }) {
  const { node, selected, onSelectAxis } = data;
  const status = node.effective_status ?? node.status ?? 'proposed';
  const downgraded = node.status === 'verified' && status !== 'verified';

  return (
    <div
      className={`vg-node vg-node--statement${selected ? ' is-selected' : ''}`}
      style={{ '--vg-node-status': statusVar(status) }}
    >
      <Handle type="target" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
      <header className="vg-node-header">
        <span className="vg-node-status" title={`status: ${status}`} />
        <div className="vg-ticks">
          {AXES.map((axis) => (
            <AxisTick key={axis} axis={axis} status={node.axes?.[axis] ?? 'not_attempted'} onSelect={onSelectAxis} />
          ))}
        </div>
      </header>
      <p className="vg-node-label">{node.label || node.id}</p>
      {downgraded ? (
        <p className="vg-node-note">{status} via a dependency</p>
      ) : null}
      <Handle type="source" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
}

/** An entity: a plain rectangle carrying its type. */
export function EntityNode({ data }) {
  const { node, selected } = data;
  return (
    <div className={`vg-node vg-node--entity${selected ? ' is-selected' : ''}`}>
      <Handle type="target" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
      <span className="vg-node-type">{node.entity_type}</span>
      <span className="vg-node-label">{node.label || node.id}</span>
      <Handle type="source" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
}

/** A relation: a pill, because it is a verb and not a thing. */
export function RelationNode({ data }) {
  const { node, selected } = data;
  return (
    <div className={`vg-node vg-node--relation${selected ? ' is-selected' : ''}`}>
      <Handle type="target" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
      <span className="vg-node-label">{node.label || node.id}</span>
      <Handle type="source" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
}

export const nodeTypes = {
  statement: StatementNode,
  entity: EntityNode,
  relation: RelationNode,
};
