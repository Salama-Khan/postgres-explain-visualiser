/**
 * adaptNode.ts — I bridge the gap between the React Flow canvas layer and the
 * domain rules engine.
 *
 * The canvas stores `ExplainNodeData` (a thin shape containing only what the
 * visual node needs).  The rules engine expects a full `NormalizedPlanNode`.
 * This module adapts the raw wire data already embedded in `ExplainNodeData`
 * into the complete `NormalizedPlanNode` shape so that `analyzeNode` can run
 * without any changes to either the canvas layer or the domain layer.
 *
 * All metrics fields that cannot be derived from the raw node without a
 * complete normalizer are set to `null` — the rules engine guards every field
 * it reads and silently skips rules when data is absent.
 */

import type {
  NormalizedBufferMetrics,
  NormalizedNodeCapabilities,
  NormalizedPlanNode,
  NormalizedPlanNodeMetrics,
  NormalizedRelation,
  PlanNodeId,
  PlanTreePath,
  RawPostgresPlanNode,
} from "../domain/postgres-plan";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * I convert a dot-path node ID (e.g. "0.1.2") into an RFC 6901-style pointer
 * into the retained raw plan so that evidence operands carry correct provenance.
 *
 * Root → "/0/Plan"
 * "0.1"  → "/0/Plan/Plans/1"
 * "0.1.2"→ "/0/Plan/Plans/1/Plans/2"
 */
function idToRawPath(id: string): string {
  const segments = id.split(".");
  // I build the path by appending /Plans/<index> for each child segment
  let path = "/0/Plan";
  for (let i = 1; i < segments.length; i++) {
    path += `/Plans/${segments[i] ?? "0"}`;
  }
  return path;
}

/**
 * I derive the buffer metrics sub-object from the raw node.
 * All fields are `number | null`; absent wire fields become `null`.
 */
function buildBufferMetrics(raw: RawPostgresPlanNode): NormalizedBufferMetrics {
  return {
    sharedHitBlocks: raw["Shared Hit Blocks"] ?? null,
    sharedReadBlocks: raw["Shared Read Blocks"] ?? null,
    sharedDirtiedBlocks: raw["Shared Dirtied Blocks"] ?? null,
    sharedWrittenBlocks: raw["Shared Written Blocks"] ?? null,
    localHitBlocks: raw["Local Hit Blocks"] ?? null,
    localReadBlocks: raw["Local Read Blocks"] ?? null,
    localDirtiedBlocks: raw["Local Dirtied Blocks"] ?? null,
    localWrittenBlocks: raw["Local Written Blocks"] ?? null,
    tempReadBlocks: raw["Temp Read Blocks"] ?? null,
    tempWrittenBlocks: raw["Temp Written Blocks"] ?? null,
    ioReadTimeMs: raw["I/O Read Time"] ?? null,
    ioWriteTimeMs: raw["I/O Write Time"] ?? null,
    localIoReadTimeMs: raw["Local I/O Read Time"] ?? null,
    localIoWriteTimeMs: raw["Local I/O Write Time"] ?? null,
    tempIoReadTimeMs: raw["Temp I/O Read Time"] ?? null,
    tempIoWriteTimeMs: raw["Temp I/O Write Time"] ?? null,
  };
}

/**
 * I build the full `NormalizedPlanNodeMetrics` object.  `rowsProcessed` and
 * `actualTimeMs` are the loop-adjusted totals (per-loop value × loops) that
 * the rules engine depends on, mirroring the derivation in `NormalizedPlanNodeMetrics`.
 */
function buildMetrics(raw: RawPostgresPlanNode): NormalizedPlanNodeMetrics {
  const loops = raw["Actual Loops"] ?? null;
  const effectiveLoops = loops ?? 1;

  const actualRowsPerLoop = raw["Actual Rows"] ?? null;
  const rowsProcessed =
    actualRowsPerLoop !== null ? actualRowsPerLoop * effectiveLoops : null;

  const actualTimeMsPerLoop = raw["Actual Total Time"] ?? null;
  const actualTimeMs =
    actualTimeMsPerLoop !== null ? actualTimeMsPerLoop * effectiveLoops : null;

  const actualStartupTimeMsPerLoop = raw["Actual Startup Time"] ?? null;

  return {
    // I spread the buffer metrics in first to satisfy the extends clause
    ...buildBufferMetrics(raw),

    // Cost fields
    startupCost: raw["Startup Cost"] ?? null,
    totalCost: raw["Total Cost"] ?? null,
    estimatedRows: raw["Plan Rows"] ?? null,
    estimatedRowWidthBytes: raw["Plan Width"] ?? null,

    // Timing
    actualStartupTimeMsPerLoop,
    actualTimeMsPerLoop,
    actualTimeMs,
    exclusiveTimeMs: null, // I leave exclusive time null — child subtraction is unsound here

    // Row counters
    actualRowsPerLoop,
    rowsProcessed,
    loops,

    // Filter-based removal counters
    rowsRemovedByFilter: raw["Rows Removed by Filter"] ?? null,
    rowsRemovedByJoinFilter: raw["Rows Removed by Join Filter"] ?? null,
    rowsRemovedByIndexRecheck: raw["Rows Removed by Index Recheck"] ?? null,

    // Heap / index metrics
    heapFetches: raw["Heap Fetches"] ?? null,
    exactHeapBlocks: raw["Exact Heap Blocks"] ?? null,
    lossyHeapBlocks: raw["Lossy Heap Blocks"] ?? null,

    // Parallelism
    workersPlanned: raw["Workers Planned"] ?? null,
    workersLaunched: raw["Workers Launched"] ?? null,

    // Sort / hash / memory
    sortSpaceUsedKb: raw["Sort Space Used"] ?? null,
    peakMemoryUsageKb: raw["Peak Memory Usage"] ?? null,
    diskUsageKb: raw["Disk Usage"] ?? null,
    hashBuckets: raw["Hash Buckets"] ?? null,
    hashBatches: raw["Hash Batches"] ?? null,

    // WAL
    walRecords: raw["WAL Records"] ?? null,
    walFullPageImages: raw["WAL FPI"] ?? null,
    walBytes: raw["WAL Bytes"] ?? null,
  };
}

/**
 * I derive the boolean capability flags that the rules engine uses to gate
 * certain diagnostics (e.g. parallel-aware vs sequential).
 */
function buildCapabilities(raw: RawPostgresPlanNode): NormalizedNodeCapabilities {
  return {
    parallelAware: raw["Parallel Aware"] ?? false,
    asyncCapable: raw["Async Capable"] ?? false,
    hasParallelWorkers: (raw["Workers Launched"] ?? 0) > 0,
    // I mark a worker shortfall when launched < planned
    hasWorkerShortfall:
      (raw["Workers Launched"] ?? 0) < (raw["Workers Planned"] ?? 0),
    hasSortSpill: (raw["Sort Space Type"] ?? "") === "Disk",
    // I treat hash batches > 1 as a spill signal
    hasHashSpill: (raw["Hash Batches"] ?? 1) > 1,
    hasDiskSpill: (raw["Disk Usage"] ?? 0) > 0,
    hasTempIo:
      (raw["Temp Read Blocks"] ?? 0) > 0 ||
      (raw["Temp Written Blocks"] ?? 0) > 0,
    hasWalActivity: (raw["WAL Records"] ?? 0) > 0,
    timingAvailable: raw["Actual Total Time"] !== undefined,
    bufferMetricsAvailable:
      raw["Shared Hit Blocks"] !== undefined ||
      raw["Shared Read Blocks"] !== undefined,
  };
}

/**
 * I extract the relation identity when the node is a scan or DML node.
 */
function buildRelation(raw: RawPostgresPlanNode): NormalizedRelation | null {
  const name = raw["Relation Name"] ?? null;
  if (name === null) return null;
  return {
    schema: raw["Schema"] ?? null,
    name,
    alias: raw["Alias"] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

/**
 * Adapt a `RawPostgresPlanNode` (plus the canvas node's dot-path `id`) into a
 * fully-shaped `NormalizedPlanNode` that the rules engine can consume.
 *
 * The returned node has `children: []` and `workers: []`.  The rules engine
 * evaluates each node in isolation so this is safe for per-node diagnostics.
 *
 * @param raw - The raw wire node from `ExplainNodeData.rawNode`.
 * @param id  - The dot-path canvas node ID (e.g. `"0.1.2"`).
 */
export function adaptRawNodeForAnalysis(
  raw: RawPostgresPlanNode,
  id: string,
): NormalizedPlanNode {
  // I construct a PlanTreePath from the dot-path string by splitting on "."
  const pathSegments = id.split(".").map(Number);
  // I cast via unknown — TypeScript cannot verify the tuple shape at compile time
  const path = pathSegments as unknown as PlanTreePath;

  // I derive the execution status so rules know whether ANALYZE data is present
  const hasAnalyzeData = raw["Actual Rows"] !== undefined;
  const executionStatus = hasAnalyzeData
    ? ((raw["Actual Rows"] ?? 0) === 0 && (raw["Actual Loops"] ?? 0) === 0
        ? "never-executed"
        : "executed")
    : "not-analyzed";

  return {
    id: id as PlanNodeId,
    path,
    // I set parentId to null — the adapter only models a single node in isolation
    parentId: null,
    depth: pathSegments.length - 1,
    nodeType: raw["Node Type"],
    parentRelationship: raw["Parent Relationship"] ?? null,
    subplanName: raw["Subplan Name"] ?? null,
    relation: buildRelation(raw),
    executionStatus,
    metrics: buildMetrics(raw),
    capabilities: buildCapabilities(raw),
    workers: [],
    children: [],
    rawPath: idToRawPath(id),
    rawNode: raw,
  };
}
