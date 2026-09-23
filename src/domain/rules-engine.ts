/**
 * rules-engine.ts — Privacy scrubber and deterministic diagnostic rules for
 * PostgreSQL EXPLAIN plans.
 *
 * Design notes
 * ============
 *
 * Privacy scrubber
 * ----------------
 * `scrubSqlLiterals` operates on condition strings extracted from EXPLAIN
 * output (Filter, Index Cond, Hash Cond, etc.).  It replaces data-carrying
 * literals — single-quoted strings and bare numeric constants — with `?`
 * before those strings appear in any diagnostic summary or evidence object.
 * This keeps user data out of logs, telemetry, and AI prompts.
 *
 * Rules engine
 * ------------
 * `analyzeNode` evaluates one `NormalizedPlanNode` in isolation and returns
 * zero or more `DiagnosticFinding` objects.  Each rule:
 *   1. Guards on data availability — absent ANALYZE data silently skips.
 *   2. Computes the mathematical predicate precisely.
 *   3. Builds a fully-populated `DiagnosticEvidence` tree so the result can
 *      be audited, re-tested, or fed to an LLM without re-deriving values.
 *   4. Assigns a confidence score that reflects the certainty of the finding
 *      under the specific conditions (parallel workers, loop count, etc.).
 *
 * Rule IDs are stable kebab-case strings prefixed with `diag.` so they can
 * be used as i18n keys, feature flags, and telemetry event names.
 *
 * Evidence operand values are `number | boolean` per the domain contract.
 * Any SQL condition strings are scrubbed and placed in `summary`, never in
 * operand values.
 */

import {
  createConfidenceScore,
  type ConfidenceScore,
  type DiagnosticEvidence,
  type DiagnosticEvidenceOperand,
  type DiagnosticEvidenceThreshold,
  type DiagnosticEvidenceUnit,
  type DiagnosticFinding,
  type DiagnosticSeverity,
  type NormalizedPlanNode,
  type PlanNodeId,
} from "./postgres-plan";

// ---------------------------------------------------------------------------
// Privacy scrubber
// ---------------------------------------------------------------------------

/**
 * Replace data-carrying SQL literals inside a PostgreSQL condition string with
 * the `?` placeholder.
 *
 * **Single-quoted strings** — PostgreSQL uses `''` to escape an embedded
 * single quote (`'it''s'`), so the regex `'(?:[^']|'')*'` correctly consumes
 * the whole literal including any escaped quotes before stopping.
 *
 * **Numeric literals** — integers and decimals (e.g. `42`, `100.50`).
 * The pattern anchors on non-word, non-dollar-sign, non-dot boundaries so
 * that column suffixes (`col_123`), PostgreSQL positional parameters (`$1`),
 * and the integer portion of an already-processed decimal are not disturbed.
 *
 * @example
 * scrubSqlLiterals("(email = 'john@doe.com' AND amount > 100.50)")
 * // → "(email = ? AND amount > ?)"
 *
 * scrubSqlLiterals("(status = $1 AND id = 42)")
 * // → "(status = $1 AND id = ?)"    — $1 is a positional param, preserved
 */
export function scrubSqlLiterals(sql: string): string {
  // Pass 1 — single-quoted string literals (handles '' escape sequences).
  // Must run before numeric replacement to avoid treating numbers inside
  // strings as standalone literals.
  let result = sql.replace(/'(?:[^']|'')*'/g, "?");

  // Pass 2 — standalone numeric literals (integers and decimals).
  // Exclusions enforced by look-around:
  //   (?<![.\w$])  — not preceded by `.`, a word char, or `$` (→ avoids $1)
  //   (?![.\d\w])  — not followed by `.`, a digit, or a word char
  result = result.replace(/(?<![.\w$])\d+(?:\.\d+)?(?![.\d\w])/g, "?");

  return result;
}

// ---------------------------------------------------------------------------
// Internal builder helpers — keep rule implementations DRY and readable
// ---------------------------------------------------------------------------

/**
 * Build a `DiagnosticEvidenceOperand` referencing a known field on the raw
 * wire node so that every finding carries full provenance.
 */
function operand(
  name: string,
  value: number | boolean,
  unit: DiagnosticEvidenceUnit,
  nodeId: PlanNodeId,
  rawPath: string,
  field: string,
): DiagnosticEvidenceOperand {
  return {
    name,
    value,
    unit,
    source: { nodeId, rawPath, field },
  };
}

/**
 * Build a `DiagnosticEvidenceOperand` for a computed/derived quantity that
 * has no single raw-field source.
 */
function derivedOperand(
  name: string,
  value: number | boolean,
  unit: DiagnosticEvidenceUnit,
): DiagnosticEvidenceOperand {
  return { name, value, unit, source: null };
}

/** Convenience constructor for a threshold object. */
function threshold(
  operator: DiagnosticEvidenceThreshold["operator"],
  value: number | boolean,
  unit: DiagnosticEvidenceUnit,
): DiagnosticEvidenceThreshold {
  return { operator, value, unit };
}

/**
 * Scale a ratio into a confidence score clamped to [lo, hi].
 * Used to reward findings that are further from the threshold.
 */
function scaledConfidence(
  ratio: number,
  thresholdValue: number,
  lo: number,
  hi: number,
): ConfidenceScore {
  // Interpolate linearly; excess beyond 10× the threshold saturates at `hi`.
  const excess = Math.min(ratio / thresholdValue, 10);
  const raw = lo + ((excess - 1) / 9) * (hi - lo);
  return createConfidenceScore(Math.min(hi, Math.max(lo, raw)));
}

// ---------------------------------------------------------------------------
// Rule 1 — Row misestimation
// ---------------------------------------------------------------------------

const RULE_ROW_MISESTIMATION = "diag.row-misestimation";
const ROW_RATIO_THRESHOLD = 10;

/**
 * Fires when the planner's row estimate is off by more than 10× in either
 * direction and the node actually executed (rowsProcessed > 0).
 *
 * Rationale: A large estimation error often leads to a sub-optimal join
 * strategy, incorrect parallelism decisions, or a hash-join that spills to
 * disk.  10× is a widely-used heuristic threshold in PostgreSQL tooling.
 *
 * Confidence scales with the magnitude of the error; a 100× miss is more
 * actionable than an 11× miss.
 */
function checkRowMisestimation(
  node: NormalizedPlanNode,
): DiagnosticFinding | null {
  const { estimatedRows, rowsProcessed } = node.metrics;

  // Guard: both values must be present and positive for division to be sound.
  if (
    estimatedRows === null ||
    rowsProcessed === null ||
    rowsProcessed === 0 ||
    estimatedRows <= 0
  ) {
    return null;
  }

  // Use the symmetric ratio (max of over- and under-estimation).
  const overRatio = rowsProcessed / estimatedRows;
  const underRatio = estimatedRows / rowsProcessed;
  const ratio = Math.max(overRatio, underRatio);

  if (ratio <= ROW_RATIO_THRESHOLD) {
    return null;
  }

  const direction = overRatio > underRatio ? "over" : "under";
  const confidence = scaledConfidence(ratio, ROW_RATIO_THRESHOLD, 0.80, 0.95);

  // Collect the scrubbed filter condition for the summary if present.
  const filterRaw = node.rawNode["Filter"] ?? node.rawNode["Index Cond"] ?? null;
  const filterClause =
    filterRaw !== null ? `  Condition: ${scrubSqlLiterals(filterRaw)}` : "";

  const summary =
    `Planner estimated ${estimatedRows.toLocaleString("en-US")} rows but ` +
    `${rowsProcessed.toLocaleString("en-US")} were processed ` +
    `(${ratio.toFixed(1)}× ${direction}-estimate).` +
    (filterClause ? `\n${filterClause}` : "");

  const evidenceOperands: DiagnosticEvidenceOperand[] = [
    operand(
      "rowsEstimated",
      estimatedRows,
      "rows",
      node.id,
      node.rawPath,
      "Plan Rows",
    ),
    operand(
      "rowsProcessed",
      rowsProcessed,
      "rows",
      node.id,
      node.rawPath,
      // rowsProcessed is Actual Rows × Actual Loops — cite the per-loop field
      "Actual Rows",
    ),
    derivedOperand("estimationRatio", ratio, "ratio"),
  ];

  const evidence: DiagnosticEvidence = {
    formula:
      "max(rowsProcessed / rowsEstimated, rowsEstimated / rowsProcessed)",
    operands: evidenceOperands,
    result: ratio,
    unit: "ratio",
    threshold: threshold(">", ROW_RATIO_THRESHOLD, "ratio"),
  };

  const finding: DiagnosticFinding = {
    ruleId: RULE_ROW_MISESTIMATION,
    severity: ratio > 100 ? "critical" : ("warning" as DiagnosticSeverity),
    confidence,
    summary,
    primaryNodeId: node.id,
    affectedNodeIds: [node.id],
    evidence: [evidence],
  };

  return finding;
}

// ---------------------------------------------------------------------------
// Rule 2 — High disk I/O (low buffer cache hit rate)
// ---------------------------------------------------------------------------

const RULE_HIGH_DISK_IO = "diag.high-disk-io";
const CACHE_HIT_RATE_THRESHOLD = 0.8; // 80 %

/**
 * Fires when shared read blocks are present and the buffer cache hit rate
 * falls below 80%.
 *
 * Rationale: A low hit rate means the node is repeatedly reading pages from
 * disk (or the OS page cache) instead of the PostgreSQL shared_buffers pool.
 * This is often a sign that `shared_buffers` is too small, the table has not
 * been accessed recently, or the working set genuinely exceeds available RAM.
 *
 * Confidence is higher when the read count is large (a small sample is noisy).
 */
function checkHighDiskIo(
  node: NormalizedPlanNode,
): DiagnosticFinding | null {
  const { sharedHitBlocks, sharedReadBlocks } = node.metrics;

  // Guard: read blocks must be present and positive; hit blocks may be zero.
  if (sharedReadBlocks === null || sharedReadBlocks === 0) {
    return null;
  }
  if (sharedHitBlocks === null) {
    return null;
  }

  const totalBlocks = sharedHitBlocks + sharedReadBlocks;
  if (totalBlocks === 0) {
    return null;
  }

  const hitRate = sharedHitBlocks / totalBlocks;

  if (hitRate >= CACHE_HIT_RATE_THRESHOLD) {
    return null;
  }

  const hitRatePct = hitRate * 100;

  // Confidence scales with read volume: large samples are more trustworthy.
  // Clamp between 0.70 (small samples) and 0.90 (large samples).
  const volumeFactor = Math.min(1, sharedReadBlocks / 1000);
  const confidenceRaw = 0.70 + volumeFactor * 0.20;
  const confidence = createConfidenceScore(
    Math.min(0.90, Math.max(0.70, confidenceRaw)),
  );

  const summary =
    `Buffer cache hit rate is ${hitRatePct.toFixed(1)}% ` +
    `(${sharedHitBlocks.toLocaleString("en-US")} hit, ` +
    `${sharedReadBlocks.toLocaleString("en-US")} read from disk). ` +
    `Consider increasing shared_buffers or warming the cache.`;

  const evidenceOperands: DiagnosticEvidenceOperand[] = [
    operand(
      "sharedHitBlocks",
      sharedHitBlocks,
      "blocks",
      node.id,
      node.rawPath,
      "Shared Hit Blocks",
    ),
    operand(
      "sharedReadBlocks",
      sharedReadBlocks,
      "blocks",
      node.id,
      node.rawPath,
      "Shared Read Blocks",
    ),
    derivedOperand("cacheHitRate", hitRate, "ratio"),
  ];

  const evidence: DiagnosticEvidence = {
    formula:
      "sharedHitBlocks / (sharedHitBlocks + sharedReadBlocks)",
    operands: evidenceOperands,
    result: hitRate,
    unit: "ratio",
    threshold: threshold("<", CACHE_HIT_RATE_THRESHOLD, "ratio"),
  };

  const finding: DiagnosticFinding = {
    ruleId: RULE_HIGH_DISK_IO,
    severity: "warning",
    confidence,
    summary,
    primaryNodeId: node.id,
    affectedNodeIds: [node.id],
    evidence: [evidence],
  };

  return finding;
}

// ---------------------------------------------------------------------------
// Rule 3 — Large sequential scan
// ---------------------------------------------------------------------------

const RULE_LARGE_SEQ_SCAN = "diag.large-seq-scan";
const SEQ_SCAN_ROW_THRESHOLD = 10_000;

/**
 * Fires when a Seq Scan node processes more than 10,000 rows.
 *
 * Rationale: A sequential scan on a large table is frequently a missed-index
 * opportunity.  10,000 rows is a pragmatic threshold — below that, a seq scan
 * can beat an index scan due to heap locality, but above it the cost
 * difference becomes significant for OLTP workloads.
 *
 * Confidence is fixed at 0.80: we observe the scan size but cannot know
 * whether a suitable index exists or would actually be used.
 *
 * The scrubbed filter condition is included in the summary so the user can
 * assess whether a partial index or a covering index would help.
 */
function checkLargeSeqScan(
  node: NormalizedPlanNode,
): DiagnosticFinding | null {
  if (node.nodeType !== "Seq Scan") {
    return null;
  }

  const { rowsProcessed } = node.metrics;

  if (rowsProcessed === null || rowsProcessed <= SEQ_SCAN_ROW_THRESHOLD) {
    return null;
  }

  // Scrub the filter condition before surfacing it.
  const filterRaw = node.rawNode["Filter"] ?? null;
  const scrubbedFilter =
    filterRaw !== null ? scrubSqlLiterals(filterRaw) : null;

  const relationLabel =
    node.relation !== null
      ? node.relation.schema !== null
        ? `${node.relation.schema}.${node.relation.name}`
        : node.relation.name
      : "unknown relation";

  const filterClause =
    scrubbedFilter !== null ? `  Filter: ${scrubbedFilter}` : "";

  const summary =
    `Sequential scan on "${relationLabel}" processed ` +
    `${rowsProcessed.toLocaleString("en-US")} rows — ` +
    `consider adding an index to reduce scan size.` +
    (filterClause ? `\n${filterClause}` : "");

  const evidenceOperands: DiagnosticEvidenceOperand[] = [
    operand(
      "rowsProcessed",
      rowsProcessed,
      "rows",
      node.id,
      node.rawPath,
      "Actual Rows",
    ),
    derivedOperand(
      "isSeqScan",
      true,
      "boolean",
    ),
  ];

  const evidence: DiagnosticEvidence = {
    formula: "nodeType = 'Seq Scan' ∧ rowsProcessed > 10000",
    operands: evidenceOperands,
    result: rowsProcessed,
    unit: "rows",
    threshold: threshold(">", SEQ_SCAN_ROW_THRESHOLD, "rows"),
  };

  const finding: DiagnosticFinding = {
    ruleId: RULE_LARGE_SEQ_SCAN,
    // Warning by default; escalate to critical for very large scans (> 1M rows)
    severity: rowsProcessed > 1_000_000 ? "critical" : "warning",
    confidence: createConfidenceScore(0.80),
    summary,
    primaryNodeId: node.id,
    affectedNodeIds: [node.id],
    evidence: [evidence],
  };

  return finding;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate all built-in diagnostic rules against a single normalised plan
 * node and return the findings in descending severity order.
 *
 * The function is pure and deterministic: given the same `NormalizedPlanNode`
 * it always returns the same findings.  It never throws — any rule that lacks
 * the required metrics silently returns `null` and is excluded from output.
 *
 * @param node - A single node from the normalised plan tree.
 * @returns    - An immutable array of findings, sorted critical → warning → info.
 *               Empty when no rules fire.
 */
export function analyzeNode(
  node: NormalizedPlanNode,
): readonly DiagnosticFinding[] {
  const rawFindings: Array<DiagnosticFinding | null> = [
    checkRowMisestimation(node),
    checkHighDiskIo(node),
    checkLargeSeqScan(node),
  ];

  const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  return rawFindings
    .filter((f): f is DiagnosticFinding => f !== null)
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
}

/**
 * Walk a normalised plan subtree recursively and collect findings from every
 * node.  Results are flattened into a single array sorted by severity.
 *
 * Useful for whole-plan analysis from a Next.js API route before filtering
 * down to a single selected node in the UI.
 *
 * @param node  - Root of the subtree to analyse (usually `NormalizedPlan.root`).
 * @returns     - All findings across the subtree, critical-first.
 */
export function analyzePlan(
  node: NormalizedPlanNode,
): readonly DiagnosticFinding[] {
  const all: DiagnosticFinding[] = [];

  function walk(n: NormalizedPlanNode): void {
    for (const finding of analyzeNode(n)) {
      all.push(finding);
    }
    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);

  const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  return all.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}
