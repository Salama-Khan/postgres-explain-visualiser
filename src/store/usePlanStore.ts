/**
 * Zustand store for the EXPLAIN plan visualiser.
 *
 * Responsibilities
 * ----------------
 * 1. Accept raw JSON text from the user.
 * 2. Validate it via `parseRawPostgresPlan` (domain layer).
 * 3. Walk the validated `RawPostgresPlanNode` tree and build React Flow
 *    `Node` and `Edge` arrays, assigning dot-path IDs that mirror the domain's
 *    `PlanNodeId` convention ("0", "0.0", "0.0.1", …).
 * 4. Apply the Dagre top-down layout so nodes arrive with real (x, y).
 * 5. Expose `selectedNodeId` and a `setSelectedNode` setter for the detail drawer.
 * 6. Persist the original `rawJsonString` so the Source Modal can display it.
 */

import { create } from "zustand";
import type { Node, Edge } from "@xyflow/react";

import {
  parseRawPostgresPlan,
  type RawPostgresPlanNode,
  type PlanValidationIssue,
} from "../domain/postgres-plan";
import { applyDagreLayout } from "../utils/layoutGraph";

// ---------------------------------------------------------------------------
// Node data contract — consumed by ExplainNode and the detail drawer
// ---------------------------------------------------------------------------

/**
 * Data attached to every React Flow node in this canvas.
 *
 * Field names deliberately mirror `NormalizedPlanNode` so that the detail
 * drawer can consume them directly once the full normalizer is wired in.
 */
export interface ExplainNodeData extends Record<string, unknown> {
  /** Maps to `NormalizedPlanNode.nodeType`. */
  nodeType: string;
  /**
   * Maps to `NormalizedPlanNode.metrics.actualTimeMs`.
   * = `"Actual Total Time"` × `"Actual Loops"` (loop-adjusted total ms).
   * `null` when ANALYZE data is absent.
   */
  actualTimeMs: number | null;
  /** Preserved for the detail drawer; never mutated. */
  rawNode: RawPostgresPlanNode;
}

/** Convenience alias — keeps the type readable in the component layer. */
export type ExplainFlowNode = Node<ExplainNodeData>;

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface PlanStoreState {
  nodes: ExplainFlowNode[];
  edges: Edge[];
  selectedNodeId: string | null;
  /** Non-null while the textarea contains an invalid plan. */
  parseError: readonly PlanValidationIssue[] | null;
  /**
   * The exact string the user pasted, preserved verbatim after a successful
   * `loadPlan` call.  Displayed in the Source Modal; `null` in the empty state.
   */
  rawJsonString: string | null;
}

interface PlanStoreActions {
  /**
   * Parse `rawJson`, build the React Flow graph with Dagre positions, and
   * write the result to the store.  On failure, `parseError` is set and
   * `nodes` / `edges` are cleared.  On success, `rawJsonString` is saved.
   */
  loadPlan: (rawJson: string) => void;
  /**
   * Set the currently selected node ID.  Stored separately from `nodes` so
   * that selection changes never trigger canvas re-renders.  Pass `null` to
   * deselect and close the detail drawer.
   */
  setSelectedNode: (id: string | null) => void;
  /**
   * Reset the entire plan state back to the empty landing state.
   * Clears nodes, edges, selection, parse errors, and the raw source string.
   */
  clearPlan: () => void;
}

type PlanStore = PlanStoreState & PlanStoreActions;

// ---------------------------------------------------------------------------
// Tree-walk helpers
// ---------------------------------------------------------------------------

/**
 * Derive `actualTimeMs` from raw timing fields.
 *
 * PostgreSQL reports *per-loop averages*, so the loop-adjusted total is
 * `Actual Total Time × Actual Loops`.  When loops is absent we fall back to
 * the per-loop value (treating it as a single pass) to match the domain
 * contract for `NormalizedPlanNodeMetrics.actualTimeMs`.
 */
function computeActualTimeMs(raw: RawPostgresPlanNode): number | null {
  const perLoop = raw["Actual Total Time"] ?? null;
  if (perLoop === null) return null;
  const loops = raw["Actual Loops"] ?? 1;
  return perLoop * loops;
}

/**
 * Recursively walk the plan tree, pushing `Node` and `Edge` entries into the
 * mutable `nodes` / `edges` arrays.
 *
 * IDs use the same dot-path convention as `PlanNodeId` so they remain
 * semantically meaningful in the detail drawer and for future diagnostics.
 */
function walkTree(
  raw: RawPostgresPlanNode,
  parentId: string | null,
  id: string,
  nodes: ExplainFlowNode[],
  edges: Edge[],
): void {
  nodes.push({
    id,
    type: "explainNode",
    // Positions are placeholder zeros — Dagre overwrites them.
    position: { x: 0, y: 0 },
    data: {
      nodeType: raw["Node Type"],
      actualTimeMs: computeActualTimeMs(raw),
      rawNode: raw,
    },
  });

  if (parentId !== null) {
    edges.push({
      id: `${parentId}->${id}`,
      source: parentId,
      target: id,
      type: "default",
    });
  }

  const children = raw.Plans ?? [];
  children.forEach((child, index) => {
    walkTree(child, id, `${id}.${String(index)}`, nodes, edges);
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** The default empty state — extracted so `clearPlan` can reuse it exactly. */
const EMPTY_STATE: PlanStoreState = {
  nodes: [],
  edges: [],
  selectedNodeId: null,
  parseError: null,
  rawJsonString: null,
};

export const usePlanStore = create<PlanStore>((set) => ({
  ...EMPTY_STATE,

  loadPlan: (rawJson: string) => {
    const result = parseRawPostgresPlan(rawJson);

    if (!result.success) {
      // On parse failure we keep any previously loaded plan intact so the
      // canvas stays visible; only the error banner updates.
      set({ parseError: result.issues });
      return;
    }

    const nodes: ExplainFlowNode[] = [];
    const edges: Edge[] = [];

    // PostgreSQL's FORMAT JSON always wraps the single envelope in a 1-element
    // array; `result.data[0]` is the validated envelope object.
    walkTree(result.data[0].Plan, null, "0", nodes, edges);

    const laidOutNodes = applyDagreLayout(nodes, edges);

    // Preserve the original pasted string so the Source Modal can display it.
    set({
      nodes: laidOutNodes,
      edges,
      parseError: null,
      selectedNodeId: null,
      rawJsonString: rawJson,
    });
  },

  setSelectedNode: (id: string | null) => {
    set({ selectedNodeId: id });
  },

  clearPlan: () => {
    set(EMPTY_STATE);
  },
}));
