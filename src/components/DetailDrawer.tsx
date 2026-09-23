"use client";

/**
 * DetailDrawer — slide-out panel showing per-node metrics for the selected
 * PostgreSQL EXPLAIN plan node.
 *
 * Animation contract
 * ------------------
 * The drawer is always mounted so the CSS transition plays smoothly.  It
 * slides in from the right edge via `translate-x-0` when open and
 * `translate-x-full` when closed, keeping the canvas fully interactive.
 *
 * Metric derivations
 * ------------------
 * All values are derived directly from `rawNode` (the validated wire model)
 * using the same formulae as `NormalizedPlanNodeMetrics` so the drawer stays
 * accurate once the full normalizer is wired in.
 *
 *   actualTimeMs   = Actual Total Time × Actual Loops
 *   rowsProcessed  = Actual Rows × Actual Loops   (loop-adjusted)
 *   rowsEstimated  = Plan Rows
 *   sharedHit      = Shared Hit Blocks
 *   sharedRead     = Shared Read Blocks
 */

import { useCallback, useEffect, useState } from "react";
import { usePlanStore } from "../store/usePlanStore";
import type { DiagnosticFinding, RawPostgresPlanNode } from "../domain/postgres-plan";
import { analyzeNode } from "../domain/rules-engine";
import { adaptRawNodeForAnalysis } from "../utils/adaptNode";
import { useStreamCompletion } from "../hooks/useStreamCompletion";

// ---------------------------------------------------------------------------
// Pure formatting helpers (no React dependencies)
// ---------------------------------------------------------------------------

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(3)} ms`;
  return `${(ms / 1000).toFixed(3)} s`;
}

function formatCount(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US");
}

function formatBlocks(n: number | null): string {
  if (n === null) return "—";
  return `${n.toLocaleString("en-US")} blk${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Derived metric helpers
// ---------------------------------------------------------------------------

function deriveActualTimeMs(raw: RawPostgresPlanNode): number | null {
  const perLoop = raw["Actual Total Time"] ?? null;
  if (perLoop === null) return null;
  return perLoop * (raw["Actual Loops"] ?? 1);
}

function deriveRowsProcessed(raw: RawPostgresPlanNode): number | null {
  const perLoop = raw["Actual Rows"] ?? null;
  if (perLoop === null) return null;
  return perLoop * (raw["Actual Loops"] ?? 1);
}

/** Severity of the estimation error, matching the `DiagnosticSeverity` scale. */
type Severity = "ok" | "warning" | "critical";

function estimationSeverity(
  estimated: number | null,
  actual: number | null,
): Severity {
  if (estimated === null || actual === null || estimated === 0) return "ok";
  const ratio = actual / estimated;
  if (ratio > 10 || ratio < 0.1) return "critical";
  if (ratio > 3 || ratio < 0.33) return "warning";
  return "ok";
}

function estimationRatioLabel(
  estimated: number | null,
  actual: number | null,
): string {
  if (estimated === null || actual === null) return "";
  if (estimated === 0) return actual === 0 ? "exact" : "∞× over";
  const ratio = actual / estimated;
  if (Math.abs(ratio - 1) < 0.05) return "exact";
  return ratio >= 1
    ? `${ratio.toFixed(1)}× over`
    : `${(1 / ratio).toFixed(1)}× under`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
        {label}
      </span>
      <div className="h-px flex-1 bg-slate-100" />
    </div>
  );
}

function MetricRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-xs text-slate-500">{label}</span>
      <span
        className={`text-xs font-medium text-slate-800 ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

const SEVERITY_BADGE: Record<Severity, string> = {
  ok: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  warning: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  critical: "bg-red-50 text-red-700 ring-1 ring-red-200",
};

function EstimationBadge({
  estimated,
  actual,
}: {
  estimated: number | null;
  actual: number | null;
}) {
  const label = estimationRatioLabel(estimated, actual);
  if (!label) return null;

  const severity = estimationSeverity(estimated, actual);
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${SEVERITY_BADGE[severity]}`}
    >
      {label}
    </span>
  );
}

/** Simple proportional bar — value clipped at 100%. */
function ProportionBar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px] text-slate-400">
        <span>{label}</span>
        <span>{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${color} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Severity styles for the AI diagnosis finding badge
// ---------------------------------------------------------------------------

const FINDING_BADGE_STYLES: Record<"info" | "warning" | "critical", string> = {
  info: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  warning: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  critical: "bg-red-50 text-red-700 ring-1 ring-red-200",
};

// ---------------------------------------------------------------------------
// Main drawer
// ---------------------------------------------------------------------------

export default function DetailDrawer() {
  const { nodes, selectedNodeId, setSelectedNode } = usePlanStore();

  // ── AI completion hook ────────────────────────────────────────────────────
  // I use the custom hook built on callCompletionApi since useCompletion was
  // removed from ai@6.  The interface is intentionally identical to the old hook.
  const {
    completion,
    isLoading,
    complete,
    error: completionError,
    setCompletion,
  } = useStreamCompletion({
    api: "/api/diagnose",
    onError: (err: Error) => {
      // I log the error but do not throw — the UI renders the error message inline
      console.error("[DetailDrawer] AI stream error:", err.message);
    },
  });

  // I track the highest-severity finding so the badge and prose stay in sync
  const [topFinding, setTopFinding] = useState<DiagnosticFinding | null>(null);

  const handleClose = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  // I find the selected node — O(n) but n ≤ 50k and the array is flat
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const isOpen = selectedNode !== null;
  const raw: RawPostgresPlanNode | null = selectedNode?.data.rawNode ?? null;

  // ── Run the rules engine whenever the selected node changes ──────────────
  useEffect(() => {
    // I reset both completion and finding state before every new analysis
    setCompletion("");
    setTopFinding(null);

    if (raw === null || selectedNodeId === null || selectedNode === null) {
      return;
    }

    // I adapt the raw wire node to a NormalizedPlanNode so analyzeNode can run
    const normalised = adaptRawNodeForAnalysis(raw, selectedNodeId);
    const findings = analyzeNode(normalised);

    if (findings.length === 0) {
      return;
    }

    // I pick the highest-severity finding (analyzeNode already returns critical-first)
    const primary = findings[0];
    setTopFinding(primary ?? null);

    if (primary === undefined) return;

    // I trigger the streaming completion; the finding is sent in the POST body
    void complete("", {
      body: {
        finding: primary,
        nodeType: selectedNode.data.nodeType,
      },
    });
    // I intentionally omit complete, setCompletion, raw, and selectedNode from
    // the deps array — they are stable references or derivations of selectedNodeId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);

  // ── Derived display metrics (unchanged from previous implementation) ──────
  const actualTimeMs = raw ? deriveActualTimeMs(raw) : null;
  const rowsEstimated: number | null = raw?.["Plan Rows"] ?? null;
  const rowsProcessed = raw ? deriveRowsProcessed(raw) : null;
  const sharedHit: number | null = raw?.["Shared Hit Blocks"] ?? null;
  const sharedRead: number | null = raw?.["Shared Read Blocks"] ?? null;
  const totalBuffers =
    sharedHit !== null && sharedRead !== null ? sharedHit + sharedRead : null;

  const nodeType = selectedNode?.data.nodeType ?? "";
  const estimationBadgeSeverity = estimationSeverity(rowsEstimated, rowsProcessed);

  return (
    <>
      {/* Backdrop — closes drawer when tapped on small screens */}
      <div
        aria-hidden="true"
        onClick={handleClose}
        className={[
          "fixed inset-0 z-20 bg-slate-900/20 backdrop-blur-[1px] transition-opacity duration-300",
          isOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        ].join(" ")}
      />

      {/* Drawer panel */}
      <aside
        aria-label="Node detail"
        className={[
          // Positioning
          "fixed inset-y-0 right-0 z-30 flex w-80 flex-col bg-white shadow-2xl",
          // Slide animation
          "transform transition-transform duration-300 ease-in-out",
          isOpen ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        {/* ---------------------------------------------------------------- */}
        {/* Header                                                           */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex shrink-0 items-start justify-between border-b border-slate-100 px-5 py-4">
          <div className="min-w-0 pr-2">
            <p className="text-[10px] font-medium uppercase tracking-widest text-slate-400">
              Plan Node
            </p>
            <h2
              className="mt-0.5 truncate text-sm font-semibold text-slate-800"
              title={nodeType}
            >
              {nodeType || "—"}
            </h2>
            {selectedNodeId && (
              <p className="mt-0.5 font-mono text-[10px] text-slate-400">
                id: {selectedNodeId}
              </p>
            )}
          </div>

          <button
            type="button"
            aria-label="Close detail panel"
            onClick={handleClose}
            className="
              mt-0.5 shrink-0 rounded-md p-1.5 text-slate-400
              hover:bg-slate-100 hover:text-slate-600
              focus:outline-none focus:ring-2 focus:ring-blue-400
            "
          >
            {/* × icon */}
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

        {/* ---------------------------------------------------------------- */}
        {/* Scrollable body                                                  */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">

          {/* ── AI Diagnosis ─────────────────────────────────────────── */}
          <section aria-label="AI Diagnosis">
            <SectionHeader label="AI Diagnosis" />

            {topFinding === null && !isLoading ? (
              // I show the no-issues state when the rules engine returns nothing
              <div className="flex min-h-[72px] items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50">
                <p className="text-xs text-slate-400">
                  No performance issues detected
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {/* Finding badge — I display the rule ID and severity */}
                {topFinding !== null && (
                  <span
                    className={[
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
                      "text-[10px] font-semibold",
                      FINDING_BADGE_STYLES[topFinding.severity],
                    ].join(" ")}
                  >
                    {/* Severity dot */}
                    <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
                    {topFinding.ruleId}
                  </span>
                )}

                {/* Streaming prose container */}
                <div
                  className={[
                    "min-h-[72px] rounded-lg border p-3 text-xs leading-relaxed",
                    completionError
                      ? "border-red-100 bg-red-50"
                      : "border-slate-100 bg-slate-50",
                  ].join(" ")}
                >
                  {/* I show an animated pulse while the first tokens arrive */}
                  {isLoading && completion.length === 0 ? (
                    <span className="flex items-center gap-2 text-slate-400">
                      <span
                        className="inline-block h-1.5 w-1.5 animate-ping rounded-full bg-blue-400"
                        aria-hidden="true"
                      />
                      Analysing&hellip;
                    </span>
                  ) : completionError ? (
                    // I surface provider errors without crashing the drawer
                    <span className="text-red-600">
                      {completionError.message.length > 0
                        ? completionError.message
                        : "AI analysis unavailable — check the API key and try again."}
                    </span>
                  ) : (
                    // I render the streaming text as it arrives token by token
                    <span className="text-slate-700">
                      {completion}
                      {/* I show a blinking cursor while tokens are still streaming */}
                      {isLoading && (
                        <span
                          className="ml-0.5 inline-block h-3 w-px animate-pulse bg-slate-400"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* ── Timing ───────────────────────────────────────────────── */}
          <section aria-label="Timing">
            <SectionHeader label="Timing" />
            <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
              <MetricRow
                label="Actual total time"
                value={formatMs(actualTimeMs)}
                mono
              />
              {raw?.["Actual Startup Time"] !== undefined && (
                <MetricRow
                  label="Startup time"
                  value={formatMs(
                    (raw["Actual Startup Time"] ?? 0) *
                      (raw["Actual Loops"] ?? 1),
                  )}
                  mono
                />
              )}
              {raw?.["Actual Loops"] !== undefined && (
                <MetricRow
                  label="Loops"
                  value={formatCount(raw["Actual Loops"] ?? null)}
                />
              )}
            </div>
          </section>

          {/* ── Row Estimation ───────────────────────────────────────── */}
          <section aria-label="Row estimation">
            <SectionHeader label="Row Estimation" />
            <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3 space-y-1">
              <MetricRow
                label="Estimated rows"
                value={formatCount(rowsEstimated)}
              />
              <MetricRow
                label="Actual rows"
                value={
                  <span className="flex items-center gap-2">
                    {formatCount(rowsProcessed)}
                    <EstimationBadge
                      estimated={rowsEstimated}
                      actual={rowsProcessed}
                    />
                  </span>
                }
              />
              {rowsEstimated !== null &&
                rowsProcessed !== null &&
                estimationBadgeSeverity !== "ok" && (
                  <p
                    className={`mt-2 rounded-md px-2 py-1.5 text-[11px] leading-snug ${
                      estimationBadgeSeverity === "critical"
                        ? "bg-red-50 text-red-600"
                        : "bg-amber-50 text-amber-600"
                    }`}
                  >
                    {estimationBadgeSeverity === "critical"
                      ? "Severely mis-estimated row count may cause a sub-optimal plan."
                      : "Row count estimate is off; consider running ANALYZE."}
                  </p>
                )}
            </div>
          </section>

          {/* ── Buffer Usage ─────────────────────────────────────────── */}
          <section aria-label="Buffer usage">
            <SectionHeader label="Buffer Usage" />
            <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3 space-y-3">
              <div className="space-y-1">
                <MetricRow
                  label="Shared hit blocks"
                  value={formatBlocks(sharedHit)}
                />
                <MetricRow
                  label="Shared read blocks"
                  value={formatBlocks(sharedRead)}
                />
              </div>

              {/* Hit-rate bar — only shown when both counters are present */}
              {totalBuffers !== null && totalBuffers > 0 && (
                <div className="pt-1 space-y-2">
                  <ProportionBar
                    label="Hit rate (cache)"
                    value={sharedHit ?? 0}
                    total={totalBuffers}
                    color="bg-emerald-400"
                  />
                  <ProportionBar
                    label="Read rate (disk)"
                    value={sharedRead ?? 0}
                    total={totalBuffers}
                    color="bg-amber-400"
                  />
                </div>
              )}

              {sharedHit === null && sharedRead === null && (
                <p className="text-[11px] text-slate-400">
                  Run with BUFFERS option to see buffer metrics.
                </p>
              )}
            </div>
          </section>

          {/* Extra node attributes (relation name, index, etc.) */}
          {raw !== null &&
            (raw["Relation Name"] ?? raw["Index Name"] ?? raw["CTE Name"]) && (
              <section aria-label="Relation">
                <SectionHeader label="Relation" />
                <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
                  {raw["Relation Name"] && (
                    <MetricRow
                      label="Relation"
                      value={
                        raw["Schema"]
                          ? `${raw["Schema"]}.${raw["Relation Name"]}`
                          : raw["Relation Name"]
                      }
                      mono
                    />
                  )}
                  {raw["Alias"] && raw["Alias"] !== raw["Relation Name"] && (
                    <MetricRow label="Alias" value={raw["Alias"]} mono />
                  )}
                  {raw["Index Name"] && (
                    <MetricRow label="Index" value={raw["Index Name"]} mono />
                  )}
                  {raw["CTE Name"] && (
                    <MetricRow label="CTE" value={raw["CTE Name"]} mono />
                  )}
                  {raw["Index Cond"] && (
                    <div className="mt-2">
                      <p className="text-[10px] font-medium text-slate-400 mb-1">
                        Index condition
                      </p>
                      <p className="break-all rounded bg-slate-100 px-2 py-1.5 font-mono text-[10px] text-slate-600">
                        {raw["Index Cond"]}
                      </p>
                    </div>
                  )}
                  {raw["Filter"] && (
                    <div className="mt-2">
                      <p className="text-[10px] font-medium text-slate-400 mb-1">
                        Filter
                      </p>
                      <p className="break-all rounded bg-slate-100 px-2 py-1.5 font-mono text-[10px] text-slate-600">
                        {raw["Filter"]}
                      </p>
                    </div>
                  )}
                </div>
              </section>
            )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Footer                                                           */}
        {/* ---------------------------------------------------------------- */}
        <div className="shrink-0 border-t border-slate-100 px-5 py-3">
          <p className="text-[10px] text-slate-400">
            Node·{selectedNodeId ?? "—"} · {nodeType}
          </p>
        </div>
      </aside>
    </>
  );
}
