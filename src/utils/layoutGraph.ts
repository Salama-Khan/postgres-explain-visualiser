/**
 * Dagre auto-layout adapter for the PostgreSQL EXPLAIN plan tree.
 *
 * Converts a flat React Flow node/edge list into a top-down ranked tree by
 * running Dagre's Sugiyama-style layout and writing back the computed (x, y)
 * positions.  The original node objects are never mutated; spread copies are
 * returned so Zustand can perform a shallow-equal comparison correctly.
 */

import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

/** Visual dimensions for every plan node box.  Refined per-type later. */
export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 72;

/** Spacing between rank layers (vertical gap) and siblings (horizontal gap). */
const RANK_SEP = 70;
const NODE_SEP = 45;

/**
 * Apply a top-down Dagre layout to `nodes` / `edges` and return a new array
 * of nodes with their `position` fields populated.
 *
 * Positions are centred on the node box so that React Flow's top-left origin
 * convention is satisfied by subtracting half the dimensions.
 */
export function applyDagreLayout<T extends Record<string, unknown>>(
  nodes: Node<T>[],
  edges: Edge[],
): Node<T>[] {
  const g = new dagre.graphlib.Graph();

  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    ranksep: RANK_SEP,
    nodesep: NODE_SEP,
    marginx: 24,
    marginy: 24,
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const { x, y } = g.node(node.id);
    return {
      ...node,
      position: {
        x: x - NODE_WIDTH / 2,
        y: y - NODE_HEIGHT / 2,
      },
    };
  });
}
