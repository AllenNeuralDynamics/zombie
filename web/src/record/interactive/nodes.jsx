import { Handle, Position } from '@xyflow/react';
import { HEADER_H, ROW_H, entriesOf, isContainer, valueSummary } from './graph.js';

const FONT = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO = '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
const CARD_SHADOW = '0 1px 2px rgba(15,23,42,0.08), 0 2px 6px rgba(15,23,42,0.10)';

const HANDLE_STYLE = { opacity: 0, width: 1, height: 1, border: 0, minWidth: 0, minHeight: 0 };

/** Colour for the inline value text, keyed off the summary kind. */
function valueColor(kind) {
  switch (kind) {
    case 'string':
      return 'var(--record-json-string, #27ae60)';
    case 'number':
      return 'var(--record-json-number, #e67e22)';
    case 'boolean':
      return 'var(--record-json-bool, #8e44ad)';
    case 'null':
      return 'var(--schema-card-text, #6b7280)';
    default:
      return '#6b7280';
  }
}

export function RecordNode({ id, data }) {
  const { value, title, color, side, fieldSide, expandedFields, onToggleField } = data;
  const entries = isContainer(value) ? entriesOf(value) : [];

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        background: 'var(--schema-card-bg, #fff)',
        border: `2px solid ${color}`,
        borderRadius: 8,
        boxShadow: CARD_SHADOW,
        fontFamily: FONT,
        overflow: 'visible',
        position: 'relative',
        // React Flow disables pointer events inside nodes when the graph is fully
        // non-interactive; our chevrons need clicks, so re-enable from here down.
        pointerEvents: 'auto',
      }}
    >
      {side ? (
        <Handle
          type="target"
          id="in"
          position={side === 'l' ? Position.Right : Position.Left}
          style={HANDLE_STYLE}
          isConnectable={false}
        />
      ) : null}

      <div
        style={{
          height: HEADER_H,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 10px',
          background: color,
          color: '#fff',
          borderRadius: '5px 5px 0 0',
        }}
      >
        <strong style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </strong>
      </div>

      {entries.map((entry, idx) => {
        const expandable = isContainer(entry.value);
        const fieldPath = `${id}::${entry.label}`;
        const expanded = expandable && expandedFields.has(fieldPath);
        const outSide = side ?? fieldSide?.[entry.label] ?? 'r';
        const summary = valueSummary(entry.value);

        return (
          <div
            key={entry.label}
            onClick={expandable ? () => onToggleField(entry.label) : undefined}
            title={summary.full ?? undefined}
            className={expandable ? 'nodrag nopan' : undefined}
            style={{
              position: 'relative',
              height: ROW_H,
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '0 8px',
              fontSize: 12,
              borderTop: idx === 0 ? 'none' : '1px solid var(--schema-card-divider, #f1f5f9)',
              cursor: expandable ? 'pointer' : 'default',
              background: expanded ? 'var(--schema-card-highlight-bg, #eef2ff)' : 'var(--schema-card-bg, #fff)',
            }}
          >
            {expandable ? (
              <span style={{ color, fontWeight: 700, fontSize: 18, width: 14, flex: '0 0 auto', lineHeight: 1 }}>
                {expanded ? '−' : '+'}
              </span>
            ) : (
              <span style={{ width: 14, flex: '0 0 auto' }} />
            )}
            <code
              style={{
                fontFamily: MONO,
                fontSize: 11.5,
                color: 'var(--schema-card-text, #111827)',
                flex: '0 0 auto',
                maxWidth: 130,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.label}
            </code>
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: MONO,
                fontSize: 11,
                color: expandable ? '#6b7280' : valueColor(summary.kind),
                fontStyle: summary.kind === 'null' ? 'italic' : 'normal',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 170,
              }}
            >
              {summary.text}
            </span>
            {expandable ? (
              <Handle
                type="source"
                id={`out-${entry.label}`}
                position={outSide === 'l' ? Position.Left : Position.Right}
                style={HANDLE_STYLE}
                isConnectable={false}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export const nodeTypes = {
  record: RecordNode,
};
