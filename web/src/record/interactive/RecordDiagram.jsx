import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeTypes } from './nodes.jsx';
import { edgeTypes } from './edges.jsx';
import { useDarkMode } from './useDarkMode.js';
import {
  NODE_WIDTH,
  branchOf,
  buildInstanceTree,
  computeFullExpansion,
  computePositions,
  computeSeedExpansion,
  coreFilesOf,
  estimateHeight,
  instanceOfFieldPath,
} from './graph.js';

/** Map each of the record's top-level core-file fields to the side its branch was assigned,
 * so the root's fields can fan out in both directions like every other card can't. */
function rootFieldSides(record) {
  const coreFiles = coreFilesOf(record);
  const half = Math.ceil(coreFiles.length / 2);
  const sides = {};
  coreFiles.forEach((key, i) => {
    sides[key] = i < half ? 'l' : 'r';
  });
  return sides;
}

function Viewer({ record }) {
  const [expandedFields, setExpandedFields] = useState(() => computeSeedExpansion(record));
  const [activeBranch, setActiveBranch] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const wrapperRef = useRef(null);
  const savedViewport = useRef(null);
  const { fitView, getViewport, setViewport } = useReactFlow();
  const isDark = useDarkMode();

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === wrapperRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    savedViewport.current = rect
      ? { ...getViewport(), width: rect.width, height: rect.height }
      : null;
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapperRef.current?.requestFullscreen();
  }, [getViewport]);

  const toggleField = useCallback((instanceId, fieldName) => {
    const fieldPath = `${instanceId}::${fieldName}`;
    setExpandedFields((prev) => {
      const next = new Set(prev);
      if (next.has(fieldPath)) next.delete(fieldPath);
      else next.add(fieldPath);
      return next;
    });
    setActiveBranch(branchOf(fieldPath));
  }, []);

  const onPaneClick = useCallback(() => {
    if (!activeBranch) return;
    const seed = computeSeedExpansion(record);
    setExpandedFields((prev) => {
      const next = new Set(prev);
      for (const fieldPath of prev) {
        if (seed.has(fieldPath)) continue;
        if (branchOf(instanceOfFieldPath(fieldPath)) === activeBranch) next.delete(fieldPath);
      }
      return next;
    });
    setActiveBranch(null);
  }, [activeBranch, record]);

  const expandAll = useCallback(() => {
    setExpandedFields(computeFullExpansion(record));
    setActiveBranch(null);
  }, [record]);

  const collapseAll = useCallback(() => {
    setExpandedFields(computeSeedExpansion(record));
    setActiveBranch(null);
  }, [record]);

  const graph = useMemo(() => {
    const { instances, edges: builtEdges } = buildInstanceTree(record, expandedFields);
    const positions = computePositions(instances, builtEdges);

    const rootSides = rootFieldSides(record);
    const nodes = instances.map((inst) => ({
      id: inst.id,
      type: 'record',
      position: positions.get(inst.id) ?? { x: 0, y: 0 },
      width: NODE_WIDTH,
      height: estimateHeight(inst),
      data: {
        value: inst.value,
        title: inst.title,
        color: inst.color,
        side: inst.side,
        fieldSide: inst.id === 'root' ? rootSides : undefined,
        expandedFields,
        onToggleField: (fieldName) => toggleField(inst.id, fieldName),
      },
    }));

    const edges = builtEdges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: 'in',
      type: 'circuit',
      data: { lane: e.lane },
      style: { stroke: e.color, strokeWidth: 1.5 },
    }));

    return { nodes, edges };
  }, [record, expandedFields, toggleField]);

  const hasFitOnce = useRef(false);

  useEffect(() => {
    if (hasFitOnce.current) return;
    hasFitOnce.current = true;
    const raf = requestAnimationFrame(() => fitView({ padding: 0.15, maxZoom: 1 }));
    return () => cancelAnimationFrame(raf);
  }, [graph, fitView]);

  useEffect(() => {
    if (!hasFitOnce.current) return;
    const saved = savedViewport.current;
    if (!saved) return;
    const raf = requestAnimationFrame(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      const newW = rect?.width ?? saved.width;
      const newH = rect?.height ?? saved.height;
      setViewport({
        zoom: saved.zoom,
        x: saved.x + (newW - saved.width) / 2,
        y: saved.y + (newH - saved.height) / 2,
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [isFullscreen, setViewport]);

  return (
    <div
      ref={wrapperRef}
      style={{
        width: '100%',
        height: isFullscreen ? '100vh' : '100%',
        background: 'var(--schema-page-bg)',
        '--schema-page-bg': isDark ? '#000' : '#fff',
        '--schema-card-bg': isDark ? '#000' : '#fff',
        '--schema-card-text': isDark ? '#fff' : '#111827',
        '--schema-card-divider': isDark ? '#27272a' : '#f1f5f9',
        '--schema-card-highlight-bg': isDark ? '#1e1b4b' : '#eef2ff',
        '--schema-dot-color': isDark ? '#3f3f46' : '#91919a',
      }}
    >
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onPaneClick={onPaneClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.01}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--schema-dot-color)" />
        <Controls showInteractive={false} />
        <Panel position="top-right" style={{ display: 'flex', gap: 8 }}>
          <button onClick={expandAll} style={panelButtonStyle}>
            Expand all
          </button>
          <button onClick={collapseAll} style={panelButtonStyle}>
            Collapse all
          </button>
          <button onClick={toggleFullscreen} style={panelButtonStyle}>
            {isFullscreen ? 'Exit fullscreen' : 'Fullscreen ⛶'}
          </button>
        </Panel>
      </ReactFlow>
    </div>
  );
}

const panelButtonStyle = {
  fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: 12,
  fontWeight: 600,
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid #c7d2fe',
  background: '#fff',
  color: '#3730a3',
  cursor: 'pointer',
  boxShadow: '0 1px 2px rgba(15,23,42,0.08)',
};

export default function RecordDiagram({ record }) {
  return (
    <ReactFlowProvider>
      <Viewer record={record} />
    </ReactFlowProvider>
  );
}
