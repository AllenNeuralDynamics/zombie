import { useCallback, useEffect, useMemo } from 'react';
import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeTypes } from './nodes.jsx';
import { computeLayout, sizeOf } from './layout.js';
import { useDarkMode } from '../../record/interactive/useDarkMode.js';

/** Derivation edges are drawn heavier than the structural triple edges. */
function edgeStyle(type, isDark) {
  const ink = isDark ? '#737373' : '#aaa39f';
  if (type === 'depends_on') {
    return { stroke: 'var(--vg-edge-derivation)', strokeWidth: 2 };
  }
  return { stroke: ink, strokeWidth: 1, strokeDasharray: type === 'relation' ? '4 3' : undefined };
}

function Viewer({ snapshot, selectedId, onSelect, onSelectAxis }) {
  const isDark = useDarkMode();
  const { fitView } = useReactFlow();

  const positions = useMemo(() => computeLayout(snapshot), [snapshot]);

  const nodes = useMemo(
    () =>
      (snapshot?.nodes ?? []).map((node) => {
        const { width, height } = sizeOf(node);
        return {
          id: node.id,
          type: node.kind,
          position: positions.get(node.id) ?? { x: 0, y: 0 },
          width,
          height,
          data: {
            node,
            selected: node.id === selectedId,
            onSelectAxis: (axis) => onSelectAxis?.(node.id, axis),
          },
        };
      }),
    [snapshot, positions, selectedId, onSelectAxis],
  );

  const edges = useMemo(
    () =>
      (snapshot?.edges ?? []).map((edge) => ({
        id: edge.id,
        // Drawn evidence → claim, matching the left-to-right layout.
        source: edge.target,
        target: edge.source,
        type: 'smoothstep',
        style: edgeStyle(edge.type, isDark),
      })),
    [snapshot, isDark],
  );

  useEffect(() => {
    const handle = window.setTimeout(() => fitView({ padding: 0.15, duration: 200 }), 0);
    return () => window.clearTimeout(handle);
  }, [fitView, snapshot]);

  const handleNodeClick = useCallback((_event, node) => onSelect?.(node.id), [onSelect]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={handleNodeClick}
      onPaneClick={() => onSelect?.(null)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} color={isDark ? '#262626' : '#ded9d1'} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/** The React Flow view of a compiled verification-graph snapshot. */
export default function GraphDiagram(props) {
  return (
    <ReactFlowProvider>
      <Viewer {...props} />
    </ReactFlowProvider>
  );
}
