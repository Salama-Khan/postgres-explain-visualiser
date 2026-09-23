"use client";

/**
 * ExplainNode — custom React Flow node for a single PostgreSQL plan node.
 *
 * Displays the node type and the loop-adjusted actual execution time.  The
 * component is intentionally minimal; Tailwind polish and the diagnostic
 * severity badge (critical / warning / ok) are added in a follow-up pass once
 * the full normalizer is wired in.
 *
 * Layout contract
 * ---------------
 * The box dimensions must match `NODE_WIDTH` × `NODE_HEIGHT` from
 * `src/utils/layoutGraph.ts` so that the Dagre spacings remain accurate.
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import type { ExplainFlowNode } from "../store/usePlanStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ms: number | null): string {
  if (ms === null) return "no timing";
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(3)} s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function ExplainNodeComponent({ data, selected }: NodeProps<ExplainFlowNode>) {
  const { nodeType, actualTimeMs } = data;

  return (
    <>
      {/* Incoming edge handle — hidden for the root node (no parent) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!border-slate-300 !bg-slate-100"
      />

      <div
        className={[
          // Fixed size matches NODE_WIDTH × NODE_HEIGHT in layoutGraph.ts
          "flex h-[72px] w-[220px] flex-col justify-center gap-0.5 rounded-lg border bg-white px-3 shadow-sm",
          selected
            ? "border-blue-500 ring-2 ring-blue-200"
            : "border-slate-200 hover:border-slate-400",
        ].join(" ")}
      >
        {/* Node type — primary label */}
        <p
          className="truncate text-[11px] font-semibold leading-tight tracking-wide text-slate-700"
          title={nodeType}
        >
          {nodeType}
        </p>

        {/* Timing — secondary metric */}
        <p className="text-[10px] leading-tight text-slate-400">
          ⏱ {formatTime(actualTimeMs)}
        </p>
      </div>

      {/* Outgoing edge handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!border-slate-300 !bg-slate-100"
      />
    </>
  );
}

export default memo(ExplainNodeComponent);
