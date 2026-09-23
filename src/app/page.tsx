"use client";

/**
 * EXPLAIN Visualiser — main page.
 *
 * Two discrete views based on whether a plan is loaded:
 *
 * ① Empty / landing state  (nodes.length === 0)
 *    A full-screen centred textarea lets the user paste a large FORMAT JSON
 *    payload comfortably.  A single "Analyse Plan" CTA submits it.
 *
 * ② Loaded / canvas state  (nodes.length > 0)
 *    The React Flow canvas fills the screen.  A slim header replaces the
 *    old paste-inline toolbar and exposes "View Raw Source" + "Clear Plan".
 *    The Source Modal (local state) shows the verbatim pasted JSON in a
 *    scrollable, read-only <pre> block with a backdrop-blur overlay.
 *
 * All graph state (nodes, edges, rawJsonString) lives in the Zustand store.
 * The only local state is `isModalOpen` — a purely UI concern.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import ExplainNode from "../components/ExplainNode";
import DetailDrawer from "../components/DetailDrawer";
import { usePlanStore } from "../store/usePlanStore";

// ---------------------------------------------------------------------------
// Custom node registry — must be stable across renders
// ---------------------------------------------------------------------------

const nodeTypes: NodeTypes = {
  explainNode: ExplainNode,
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function VisualisePage() {
  const {
    nodes,
    edges,
    selectedNodeId,
    parseError,
    rawJsonString,
    loadPlan,
    setSelectedNode,
    clearPlan,
  } = usePlanStore();

  // ── Local UI state ────────────────────────────────────────────────────────
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Uncontrolled ref so large JSON pastes never trigger component re-renders
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleAnalyse = useCallback(() => {
    const raw = textareaRef.current?.value.trim() ?? "";
    if (raw.length > 0) {
      loadPlan(raw);
    }
  }, [loadPlan]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleAnalyse();
      }
    },
    [handleAnalyse],
  );

  const handleClear = useCallback(() => {
    setIsModalOpen(false);
    clearPlan();
    // Reset the textarea so it is blank when the landing view re-mounts
    if (textareaRef.current) {
      textareaRef.current.value = "";
    }
  }, [clearPlan]);

  const openModal = useCallback(() => setIsModalOpen(true), []);
  const closeModal = useCallback(() => setIsModalOpen(false), []);

  // Close the modal on Escape key
  useEffect(() => {
    if (!isModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalOpen, closeModal]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      setSelectedNode(node.id === selectedNodeId ? null : node.id);
    },
    [setSelectedNode, selectedNodeId],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  // ── Render ────────────────────────────────────────────────────────────────

  const isPlanLoaded = nodes.length > 0;

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-slate-50">

      {/* ================================================================== */}
      {/* ① EMPTY / LANDING STATE                                            */}
      {/* ================================================================== */}
      {!isPlanLoaded && (
        <div className="flex flex-1 flex-col items-center justify-center px-4 py-10">

          {/* Wordmark */}
          <div className="mb-8 text-center">
            <h1 className="text-2xl font-bold tracking-tight text-slate-800">
              EXPLAIN Visualiser
            </h1>
            <p className="mt-1.5 text-sm text-slate-500">
              Paste the output of{" "}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
              </code>{" "}
              below
            </p>
          </div>

          {/* Paste area */}
          <div className="w-full max-w-3xl space-y-3">
            <textarea
              ref={textareaRef}
              rows={16}
              spellCheck={false}
              autoFocus
              onKeyDown={handleKeyDown}
              placeholder={`[\n  {\n    "Plan": {\n      "Node Type": "Seq Scan",\n      ...\n    }\n  }\n]`}
              aria-label="Paste EXPLAIN JSON"
              className="
                w-full resize-y rounded-xl border border-slate-200 bg-white
                px-4 py-3 font-mono text-xs text-slate-700 shadow-sm
                placeholder:text-slate-300
                focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200
              "
            />

            {/* Parse error — shown inline under the textarea */}
            {parseError !== null && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5"
              >
                {/* Warning icon */}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="mt-px h-3.5 w-3.5 shrink-0 text-red-500"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                    clipRule="evenodd"
                  />
                </svg>
                <div>
                  <p className="text-xs font-semibold text-red-700">
                    Invalid EXPLAIN JSON
                  </p>
                  <p className="mt-0.5 text-xs text-red-600">
                    {parseError[0]?.message ?? "Unknown parse error."}
                    {parseError.length > 1 && (
                      <span className="ml-1 text-red-400">
                        (+{parseError.length - 1} more issue
                        {parseError.length > 2 ? "s" : ""})
                      </span>
                    )}
                  </p>
                </div>
              </div>
            )}

            {/* CTA */}
            <button
              type="button"
              onClick={handleAnalyse}
              className="
                w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold
                text-white shadow-sm transition-colors
                hover:bg-blue-700 active:bg-blue-800
                focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2
              "
            >
              Analyse Plan
              <span className="ml-2 text-blue-300 text-xs font-normal">⌘↵</span>
            </button>
          </div>
        </div>
      )}

      {/* ================================================================== */}
      {/* ② LOADED / CANVAS STATE                                            */}
      {/* ================================================================== */}
      {isPlanLoaded && (
        <>
          {/* Slim header — no paste input, just controls */}
          <header className="z-10 flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-3 shadow-sm">
            <div className="flex items-center gap-2.5">
              {/* Back chevron → clear plan */}
              <button
                type="button"
                aria-label="Back to landing"
                onClick={handleClear}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
              <span className="text-sm font-semibold text-slate-700">
                EXPLAIN Visualiser
              </span>
              <span className="hidden rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 sm:inline">
                {nodes.length} node{nodes.length !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {/* View Raw Source */}
              <button
                type="button"
                onClick={openModal}
                className="
                  flex items-center gap-1.5 rounded-md border border-slate-200
                  bg-white px-3 py-1.5 text-xs font-medium text-slate-600
                  shadow-sm transition-colors
                  hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800
                  focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1
                "
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3.5 w-3.5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
                View Raw Source
              </button>

              {/* Clear Plan */}
              <button
                type="button"
                onClick={handleClear}
                className="
                  flex items-center gap-1.5 rounded-md border border-slate-200
                  bg-white px-3 py-1.5 text-xs font-medium text-slate-500
                  shadow-sm transition-colors
                  hover:border-red-200 hover:bg-red-50 hover:text-red-600
                  focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-1
                "
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3.5 w-3.5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
                Clear Plan
              </button>
            </div>
          </header>

          {/* Canvas */}
          <div className="flex-1">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.1}
              maxZoom={2}
              proOptions={{ hideAttribution: false }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={16}
                size={1}
                color="#cbd5e1"
              />
              <Controls />
              <MiniMap
                nodeColor="#3b82f6"
                maskColor="rgba(241,245,249,0.7)"
                className="rounded-lg border border-slate-200 shadow-sm"
              />
            </ReactFlow>
          </div>
        </>
      )}

      {/* ================================================================== */}
      {/* Detail drawer — always mounted so the slide animation plays        */}
      {/* ================================================================== */}
      <DetailDrawer />

      {/* ================================================================== */}
      {/* Source modal                                                        */}
      {/* ================================================================== */}
      {isModalOpen && (
        <>
          {/* Backdrop */}
          <div
            aria-hidden="true"
            onClick={closeModal}
            className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm"
          />

          {/* Dialog */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Raw plan source"
            className="
              fixed inset-x-4 inset-y-8 z-50 mx-auto flex max-w-4xl flex-col
              overflow-hidden rounded-2xl bg-white shadow-2xl
              sm:inset-x-8 sm:inset-y-12
            "
          >
            {/* Modal header */}
            <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-6 py-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-800">
                  Raw Plan Source
                </h2>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  Verbatim text that was submitted to the parser
                </p>
              </div>
              <button
                type="button"
                aria-label="Close source modal"
                onClick={closeModal}
                className="
                  rounded-md p-1.5 text-slate-400
                  hover:bg-slate-100 hover:text-slate-600
                  focus:outline-none focus:ring-2 focus:ring-blue-400
                "
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>

            {/* Scrollable source block */}
            <div className="flex-1 overflow-auto bg-slate-950 p-1">
              <pre className="h-full">
                <code className="block h-full p-5 font-mono text-xs leading-relaxed text-slate-300 whitespace-pre">
                  {rawJsonString ?? ""}
                </code>
              </pre>
            </div>

            {/* Modal footer */}
            <div className="flex shrink-0 items-center justify-between border-t border-slate-100 bg-slate-50 px-6 py-3">
              <p className="text-[11px] text-slate-400">
                {rawJsonString !== null
                  ? `${rawJsonString.length.toLocaleString("en-US")} chars · ${nodes.length} node${nodes.length !== 1 ? "s" : ""}`
                  : "No source available"}
              </p>
              <button
                type="button"
                onClick={closeModal}
                className="
                  rounded-md bg-slate-800 px-4 py-1.5 text-xs font-medium
                  text-white hover:bg-slate-700 active:bg-slate-900
                  focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-1
                "
              >
                Close
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
