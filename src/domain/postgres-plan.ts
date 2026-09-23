/**
 * Core contracts for PostgreSQL `EXPLAIN (..., FORMAT JSON)` plans.
 *
 * Architecture assumptions and corrections
 * ----------------------------------------
 * 1. "Lossless" means that, after JSON parsing, no PostgreSQL or extension
 *    field is discarded or coerced. JavaScript numbers cannot preserve the
 *    original JSON numeric lexeme or integers above Number.MAX_SAFE_INTEGER.
 *    Consumers requiring lexical numeric fidelity must retain the source text
 *    or introduce a big-number JSON parser at the ingestion boundary.
 * 2. Positional IDs are stable only for an immutable tree. Adding, removing,
 *    or reordering a sibling necessarily changes subsequent positional IDs.
 * 3. JIT, triggers, settings, and planning/execution totals belong to the plan
 *    envelope. They are intentionally not duplicated on every normalized node.
 * 4. PostgreSQL reports actual rows and times as per-loop averages. The
 *    normalized model stores both reported values and loop-adjusted totals.
 * 5. Exclusive time is nullable. Child subtraction is not sound for parallel
 *    execution, incompatible loop counts, absent timing, or overlapping
 *    instrumentation, and callers must not silently clamp uncertain values.
 * 6. The validator accepts PostgreSQL's native one-element array only. SQL
 *    client wrappers and double-encoded JSON require an explicit adapter.
 */

/** A primitive value representable by JSON. */
export type JsonPrimitive = string | number | boolean | null;

/** A recursively JSON-safe value. Readonly arrays also accept parsed arrays. */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

/**
 * Open JSON object used by the raw wire model.
 *
 * `undefined` appears only in the index signature to permit optional known
 * fields under `exactOptionalPropertyTypes`; a present `undefined` value is
 * rejected by runtime validation because it is not valid JSON.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/** Buffer counters emitted on plan nodes, workers, and planning summaries. */
export interface RawPostgresBufferFields extends JsonObject {
  readonly "Shared Hit Blocks"?: number;
  readonly "Shared Read Blocks"?: number;
  readonly "Shared Dirtied Blocks"?: number;
  readonly "Shared Written Blocks"?: number;
  readonly "Local Hit Blocks"?: number;
  readonly "Local Read Blocks"?: number;
  readonly "Local Dirtied Blocks"?: number;
  readonly "Local Written Blocks"?: number;
  readonly "Temp Read Blocks"?: number;
  readonly "Temp Written Blocks"?: number;
  readonly "I/O Read Time"?: number;
  readonly "I/O Write Time"?: number;
  readonly "Local I/O Read Time"?: number;
  readonly "Local I/O Write Time"?: number;
  readonly "Temp I/O Read Time"?: number;
  readonly "Temp I/O Write Time"?: number;
}

/** WAL counters available when EXPLAIN's WAL option is enabled. */
export interface RawPostgresWalFields extends JsonObject {
  readonly "WAL Records"?: number;
  readonly "WAL FPI"?: number;
  readonly "WAL Bytes"?: number;
}

/** Per-worker metrics nested under a node's `Workers` array. */
export interface RawPostgresWorker
  extends RawPostgresBufferFields,
    RawPostgresWalFields {
  readonly "Worker Number"?: number;
  readonly "Actual Startup Time"?: number;
  readonly "Actual Total Time"?: number;
  readonly "Actual Rows"?: number;
  readonly "Actual Loops"?: number;
  readonly "Sort Method"?: string;
  readonly "Sort Space Used"?: number;
  readonly "Sort Space Type"?: string;
  readonly "Peak Memory Usage"?: number;
  readonly "Disk Usage"?: number;
}

/** JIT options have remained boolean, while unknown future options stay open. */
export interface RawPostgresJitOptions extends JsonObject {
  readonly Inlining?: boolean;
  readonly Optimization?: boolean;
  readonly Expressions?: boolean;
  readonly Deforming?: boolean;
}

/** JIT timing values are milliseconds. */
export interface RawPostgresJitTiming extends JsonObject {
  readonly Generation?: number;
  readonly Inlining?: number;
  readonly Optimization?: number;
  readonly Emission?: number;
  readonly Total?: number;
}

/** Query-level JIT summary. */
export interface RawPostgresJit extends JsonObject {
  readonly Functions?: number;
  readonly Options?: RawPostgresJitOptions;
  readonly Timing?: RawPostgresJitTiming;
}

/** Trigger summary emitted at the EXPLAIN envelope level. */
export interface RawPostgresTrigger extends JsonObject {
  readonly "Trigger Name"?: string;
  readonly "Constraint Name"?: string;
  readonly Relation?: string;
  readonly Time?: number;
  readonly Calls?: number;
}

/** Planning statistics, including planning buffers and PG 18+ additions. */
export interface RawPostgresPlanning extends RawPostgresBufferFields {
  readonly "Planning Time"?: number;
}

/**
 * A PostgreSQL plan node with common fields typed explicitly.
 *
 * Node type is deliberately a string rather than a closed union: extensions
 * and future PostgreSQL versions can introduce node types without invalidating
 * an otherwise usable plan. The inherited index signature preserves every
 * unrecognized field.
 */
export interface RawPostgresPlanNode
  extends RawPostgresBufferFields,
    RawPostgresWalFields {
  readonly "Node Type": string;
  readonly "Parent Relationship"?: string;
  readonly "Subplan Name"?: string;
  readonly "Parallel Aware"?: boolean;
  readonly "Async Capable"?: boolean;
  readonly "Join Type"?: string;
  readonly "Strategy"?: string;
  readonly "Partial Mode"?: string;
  readonly "Operation"?: string;

  readonly "Startup Cost"?: number;
  readonly "Total Cost"?: number;
  readonly "Plan Rows"?: number;
  readonly "Plan Width"?: number;
  readonly "Actual Startup Time"?: number;
  readonly "Actual Total Time"?: number;
  readonly "Actual Rows"?: number;
  readonly "Actual Loops"?: number;

  readonly "Rows Removed by Filter"?: number;
  readonly "Rows Removed by Join Filter"?: number;
  readonly "Rows Removed by Index Recheck"?: number;
  readonly "Heap Fetches"?: number;
  readonly "Exact Heap Blocks"?: number;
  readonly "Lossy Heap Blocks"?: number;
  readonly "Subplans Removed"?: number;

  readonly "Workers Planned"?: number;
  readonly "Workers Launched"?: number;
  readonly "Single Copy"?: boolean;
  readonly Workers?: readonly RawPostgresWorker[];

  readonly "Sort Method"?: string;
  readonly "Sort Space Used"?: number;
  readonly "Sort Space Type"?: string;
  readonly "Peak Memory Usage"?: number;
  readonly "Disk Usage"?: number;
  readonly "Hash Buckets"?: number;
  readonly "Original Hash Buckets"?: number;
  readonly "Hash Batches"?: number;
  readonly "Original Hash Batches"?: number;

  readonly "Relation Name"?: string;
  readonly "Schema"?: string;
  readonly "Alias"?: string;
  readonly "Index Name"?: string;
  readonly "CTE Name"?: string;
  readonly "Function Name"?: string;
  readonly "Table Function Name"?: string;
  readonly "Custom Plan Provider"?: string;
  readonly "Scan Direction"?: string;

  readonly Filter?: string;
  readonly "Index Cond"?: string;
  readonly "Recheck Cond"?: string;
  readonly "Hash Cond"?: string;
  readonly "Merge Cond"?: string;
  readonly "Join Filter"?: string;
  readonly "TID Cond"?: string;
  readonly "Conflict Resolution"?: string;

  readonly Output?: readonly string[];
  readonly "Sort Key"?: readonly string[];
  readonly "Presorted Key"?: readonly string[];
  readonly "Group Key"?: readonly string[];
  readonly "Hash Key"?: readonly string[];
  readonly "Conflict Arbiter Indexes"?: readonly string[];

  readonly Plans?: readonly RawPostgresPlanNode[];
}

/** One object inside PostgreSQL's top-level EXPLAIN JSON array. */
export interface RawPostgresExplain extends JsonObject {
  readonly Plan: RawPostgresPlanNode;
  readonly "Planning Time"?: number;
  readonly "Execution Time"?: number;
  readonly "Serialization Time"?: number;
  readonly "Query Identifier"?: number;
  readonly Planning?: RawPostgresPlanning;
  readonly Triggers?: readonly RawPostgresTrigger[];
  readonly JIT?: RawPostgresJit;
  readonly Settings?: JsonObject;
}

/**
 * Native PostgreSQL FORMAT JSON output.
 *
 * EXPLAIN describes one statement and PostgreSQL emits exactly one envelope
 * object. The tuple encodes that invariant rather than accepting arbitrary
 * multi-root arrays produced by unrelated tooling.
 */
export type RawPostgresPlan = readonly [RawPostgresExplain];

declare const planNodeIdBrand: unique symbol;

/** A dot-separated positional node ID such as `0.2.1`. */
export type PlanNodeId = string & {
  readonly [planNodeIdBrand]: "PlanNodeId";
};

/**
 * Numeric counterpart of a positional ID. The root path is always `[0]`.
 * Every segment is a non-negative safe integer.
 */
export type PlanTreePath = readonly [
  root: 0,
  ...descendants: readonly number[],
];

/** Construct a validated positional node ID from a tree path. */
export function createPlanNodeId(path: PlanTreePath): PlanNodeId {
  if (
    path.length === 0 ||
    path[0] !== 0 ||
    path.some(
      (segment) => !Number.isSafeInteger(segment) || segment < 0,
    )
  ) {
    throw new RangeError(
      "A plan tree path must start at 0 and contain non-negative safe integers.",
    );
  }

  return path.join(".") as PlanNodeId;
}

/** Parse an external string as a positional ID without throwing. */
export function parsePlanNodeId(value: string): PlanNodeId | null {
  if (!/^(?:0)(?:\.(?:0|[1-9]\d*))*$/.test(value)) {
    return null;
  }

  const isSafe = value
    .split(".")
    .every((segment) => Number.isSafeInteger(Number(segment)));
  return isSafe ? (value as PlanNodeId) : null;
}

/** Return an immutable child path while enforcing a valid child index. */
export function createChildTreePath(
  parent: PlanTreePath,
  childIndex: number,
): PlanTreePath {
  if (!Number.isSafeInteger(childIndex) || childIndex < 0) {
    throw new RangeError("A child index must be a non-negative safe integer.");
  }

  return [...parent, childIndex] as PlanTreePath;
}

/** Availability is explicit so absence is never confused with a zero metric. */
export interface NormalizedMetricAvailability {
  readonly hasAnalyze: boolean;
  readonly hasTiming: boolean;
  readonly hasBuffers: boolean;
  readonly hasCosts: boolean;
  readonly hasWal: boolean;
}

/** Query-level feature observations that do not belong to an individual node. */
export interface NormalizedPlanCapabilities {
  readonly jitObserved: boolean;
  readonly triggersObserved: boolean;
  readonly settingsObserved: boolean;
  readonly planningBuffersObserved: boolean;
  readonly serializationObserved: boolean;
  readonly memoryObserved: boolean;
}

/** Buffer counters are inclusive of descendants in PostgreSQL output. */
export interface NormalizedBufferMetrics {
  readonly sharedHitBlocks: number | null;
  readonly sharedReadBlocks: number | null;
  readonly sharedDirtiedBlocks: number | null;
  readonly sharedWrittenBlocks: number | null;
  readonly localHitBlocks: number | null;
  readonly localReadBlocks: number | null;
  readonly localDirtiedBlocks: number | null;
  readonly localWrittenBlocks: number | null;
  readonly tempReadBlocks: number | null;
  readonly tempWrittenBlocks: number | null;
  readonly ioReadTimeMs: number | null;
  readonly ioWriteTimeMs: number | null;
  readonly localIoReadTimeMs: number | null;
  readonly localIoWriteTimeMs: number | null;
  readonly tempIoReadTimeMs: number | null;
  readonly tempIoWriteTimeMs: number | null;
}

/**
 * Closed, unit-explicit metrics used by the rules engine.
 *
 * `actualRowsPerLoop` and `actualTimeMsPerLoop` mirror PostgreSQL. Their
 * loop-adjusted counterparts are `rowsProcessed` and `actualTimeMs`.
 * Buffer values remain PostgreSQL's inclusive counters; subtracting child
 * counters is a separate, confidence-aware normalization operation.
 */
export interface NormalizedPlanNodeMetrics extends NormalizedBufferMetrics {
  readonly startupCost: number | null;
  readonly totalCost: number | null;
  readonly estimatedRows: number | null;
  readonly estimatedRowWidthBytes: number | null;

  readonly actualStartupTimeMsPerLoop: number | null;
  readonly actualTimeMsPerLoop: number | null;
  readonly actualTimeMs: number | null;
  readonly exclusiveTimeMs: number | null;
  readonly actualRowsPerLoop: number | null;
  readonly rowsProcessed: number | null;
  readonly loops: number | null;

  readonly rowsRemovedByFilter: number | null;
  readonly rowsRemovedByJoinFilter: number | null;
  readonly rowsRemovedByIndexRecheck: number | null;
  readonly heapFetches: number | null;
  readonly exactHeapBlocks: number | null;
  readonly lossyHeapBlocks: number | null;

  readonly workersPlanned: number | null;
  readonly workersLaunched: number | null;
  readonly sortSpaceUsedKb: number | null;
  readonly peakMemoryUsageKb: number | null;
  readonly diskUsageKb: number | null;
  readonly hashBuckets: number | null;
  readonly hashBatches: number | null;
  readonly walRecords: number | null;
  readonly walFullPageImages: number | null;
  readonly walBytes: number | null;
}

/** Execution state separates missing ANALYZE data from a zero-row execution. */
export type NormalizedExecutionStatus =
  | "not-analyzed"
  | "executed"
  | "never-executed"
  | "unknown";

/** Node-local observations used to gate diagnostics and derived calculations. */
export interface NormalizedNodeCapabilities {
  readonly parallelAware: boolean;
  readonly asyncCapable: boolean;
  readonly hasParallelWorkers: boolean;
  readonly hasWorkerShortfall: boolean;
  readonly hasSortSpill: boolean;
  readonly hasHashSpill: boolean;
  readonly hasDiskSpill: boolean;
  readonly hasTempIo: boolean;
  readonly hasWalActivity: boolean;
  readonly timingAvailable: boolean;
  readonly bufferMetricsAvailable: boolean;
}

/** Normalized per-worker detail without pretending workers are tree children. */
export interface NormalizedWorkerMetrics {
  readonly workerNumber: number | null;
  readonly actualStartupTimeMsPerLoop: number | null;
  readonly actualTimeMsPerLoop: number | null;
  readonly actualTimeMs: number | null;
  readonly actualRowsPerLoop: number | null;
  readonly rowsProcessed: number | null;
  readonly loops: number | null;
  readonly buffers: NormalizedBufferMetrics;
  readonly rawWorker: RawPostgresWorker;
}

/** Optional relation identity for scans and data-modification nodes. */
export interface NormalizedRelation {
  readonly schema: string | null;
  readonly name: string;
  readonly alias: string | null;
}

/**
 * Strongly typed internal plan tree.
 *
 * Unknown wire fields remain available through `rawNode`, while normalized
 * consumers operate on this closed shape and never depend on extension keys.
 */
export interface NormalizedPlanNode {
  readonly id: PlanNodeId;
  readonly path: PlanTreePath;
  readonly parentId: PlanNodeId | null;
  readonly depth: number;
  readonly nodeType: string;
  readonly parentRelationship: string | null;
  readonly subplanName: string | null;
  readonly relation: NormalizedRelation | null;
  readonly executionStatus: NormalizedExecutionStatus;
  readonly metrics: NormalizedPlanNodeMetrics;
  readonly capabilities: NormalizedNodeCapabilities;
  readonly workers: readonly NormalizedWorkerMetrics[];
  readonly children: readonly NormalizedPlanNode[];
  /** RFC 6901-style pointer into the retained raw plan. */
  readonly rawPath: string;
  /** Direct provenance reference; normalization must never mutate it. */
  readonly rawNode: RawPostgresPlanNode;
}

/** Normalized trigger metrics retained at plan scope. */
export interface NormalizedTrigger {
  readonly name: string | null;
  readonly constraintName: string | null;
  readonly relation: string | null;
  readonly timeMs: number | null;
  readonly calls: number | null;
  readonly rawTrigger: RawPostgresTrigger;
}

/** Normalized query-level JIT details. */
export interface NormalizedJitSummary {
  readonly functions: number | null;
  readonly generationTimeMs: number | null;
  readonly inliningTimeMs: number | null;
  readonly optimizationTimeMs: number | null;
  readonly emissionTimeMs: number | null;
  readonly totalTimeMs: number | null;
  readonly rawJit: RawPostgresJit;
}

/** Root aggregate consumed by normalization and diagnostic engines. */
export interface NormalizedPlan {
  readonly root: NormalizedPlanNode;
  readonly availability: NormalizedMetricAvailability;
  readonly capabilities: NormalizedPlanCapabilities;
  readonly planningTimeMs: number | null;
  readonly executionTimeMs: number | null;
  readonly serializationTimeMs: number | null;
  readonly triggers: readonly NormalizedTrigger[];
  readonly jit: NormalizedJitSummary | null;
  readonly settings: Readonly<Record<string, JsonValue>>;
  /** Complete wire model retained for provenance and future re-normalization. */
  readonly rawPlan: RawPostgresPlan;
}

/** Stable severity levels ordered by diagnostic urgency. */
export type DiagnosticSeverity = "info" | "warning" | "critical";

declare const confidenceScoreBrand: unique symbol;

/** A finite diagnostic confidence in the inclusive range 0..1. */
export type ConfidenceScore = number & {
  readonly [confidenceScoreBrand]: "ConfidenceScore";
};

/** Create a bounded confidence score for a finding. */
export function createConfidenceScore(value: number): ConfidenceScore {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("Diagnostic confidence must be between 0 and 1.");
  }

  return value as ConfidenceScore;
}

/** Units keep raw evidence machine-readable and prevent invalid comparisons. */
export type DiagnosticEvidenceUnit =
  | "milliseconds"
  | "rows"
  | "blocks"
  | "bytes"
  | "kilobytes"
  | "cost"
  | "count"
  | "ratio"
  | "percent"
  | "boolean"
  | "none";

/** Exact source of an operand when it originated in PostgreSQL JSON. */
export interface DiagnosticRawFieldReference {
  readonly nodeId: PlanNodeId | null;
  readonly rawPath: string;
  readonly field: string;
}

/** One named, unrounded value used in a diagnostic formula. */
export interface DiagnosticEvidenceOperand {
  readonly name: string;
  readonly value: number | boolean;
  readonly unit: DiagnosticEvidenceUnit;
  readonly source: DiagnosticRawFieldReference | null;
}

/** Optional rule threshold shown alongside the computed result. */
export interface DiagnosticEvidenceThreshold {
  readonly operator: ">" | ">=" | "<" | "<=" | "=" | "!=";
  readonly value: number | boolean;
  readonly unit: DiagnosticEvidenceUnit;
}

/**
 * Raw mathematical evidence for one rule assertion.
 *
 * The formula is display text, while operands/result/threshold retain the
 * unformatted values required for auditing, retesting, and explanation.
 */
export interface DiagnosticEvidence {
  readonly formula: string;
  readonly operands: readonly DiagnosticEvidenceOperand[];
  readonly result: number | boolean;
  readonly unit: DiagnosticEvidenceUnit;
  readonly threshold: DiagnosticEvidenceThreshold | null;
}

/** Deterministic rules-engine output; summaries must be supported by evidence. */
export interface DiagnosticFinding {
  readonly ruleId: string;
  readonly severity: DiagnosticSeverity;
  readonly confidence: ConfidenceScore;
  readonly summary: string;
  readonly primaryNodeId: PlanNodeId | null;
  readonly affectedNodeIds: readonly PlanNodeId[];
  readonly evidence: readonly DiagnosticEvidence[];
}

/** A path segment in a structured validation error. */
export type ValidationPathSegment = string | number;

/** Stable machine-readable categories for ingestion failures. */
export type PlanValidationIssueCode =
  | "invalid-json"
  | "input-too-large"
  | "invalid-root"
  | "invalid-root-length"
  | "expected-object"
  | "missing-field"
  | "invalid-field-type"
  | "non-finite-number"
  | "invalid-json-value"
  | "depth-limit-exceeded"
  | "node-limit-exceeded"
  | "value-limit-exceeded"
  | "unexpected-access-error";

/** One path-aware issue suitable for UI or logs without throwing. */
export interface PlanValidationIssue {
  readonly code: PlanValidationIssueCode;
  readonly path: readonly ValidationPathSegment[];
  readonly message: string;
}

/** Resource limits protect ingestion of large or adversarial pasted payloads. */
export interface PlanValidationLimits {
  /** Maximum UTF-8 bytes accepted when the input is a JSON string. */
  readonly maxInputBytes: number;
  /** Maximum nesting across all JSON arrays and objects. */
  readonly maxDepth: number;
  /** Maximum count of objects identified as PostgreSQL plan nodes. */
  readonly maxNodes: number;
  /** Maximum count of all recursively visited JSON values. */
  readonly maxValues: number;
  /** Maximum issues collected before validation stops reporting more. */
  readonly maxIssues: number;
}

/** Defaults are conservative enough for large real plans but bound total work. */
export const DEFAULT_PLAN_VALIDATION_LIMITS: PlanValidationLimits = {
  maxInputBytes: 5 * 1024 * 1024,
  maxDepth: 256,
  maxNodes: 50_000,
  maxValues: 500_000,
  maxIssues: 100,
};

/** Discriminated non-throwing result returned at the user-input boundary. */
export type PlanValidationResult =
  | {
      readonly success: true;
      readonly data: RawPostgresPlan;
    }
  | {
      readonly success: false;
      readonly issues: readonly PlanValidationIssue[];
    };

const ENVELOPE_NUMBER_FIELDS = [
  "Planning Time",
  "Execution Time",
  "Serialization Time",
  "Query Identifier",
] as const;

const NODE_NUMBER_FIELDS = [
  "Startup Cost",
  "Total Cost",
  "Plan Rows",
  "Plan Width",
  "Actual Startup Time",
  "Actual Total Time",
  "Actual Rows",
  "Actual Loops",
  "Rows Removed by Filter",
  "Rows Removed by Join Filter",
  "Rows Removed by Index Recheck",
  "Heap Fetches",
  "Exact Heap Blocks",
  "Lossy Heap Blocks",
  "Subplans Removed",
  "Workers Planned",
  "Workers Launched",
  "Sort Space Used",
  "Peak Memory Usage",
  "Disk Usage",
  "Hash Buckets",
  "Original Hash Buckets",
  "Hash Batches",
  "Original Hash Batches",
  "WAL Records",
  "WAL FPI",
  "WAL Bytes",
  "Shared Hit Blocks",
  "Shared Read Blocks",
  "Shared Dirtied Blocks",
  "Shared Written Blocks",
  "Local Hit Blocks",
  "Local Read Blocks",
  "Local Dirtied Blocks",
  "Local Written Blocks",
  "Temp Read Blocks",
  "Temp Written Blocks",
  "I/O Read Time",
  "I/O Write Time",
  "Local I/O Read Time",
  "Local I/O Write Time",
  "Temp I/O Read Time",
  "Temp I/O Write Time",
] as const;

const NODE_STRING_FIELDS = [
  "Node Type",
  "Parent Relationship",
  "Subplan Name",
  "Join Type",
  "Strategy",
  "Partial Mode",
  "Operation",
  "Sort Method",
  "Sort Space Type",
  "Relation Name",
  "Schema",
  "Alias",
  "Index Name",
  "CTE Name",
  "Function Name",
  "Table Function Name",
  "Custom Plan Provider",
  "Scan Direction",
  "Filter",
  "Index Cond",
  "Recheck Cond",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  "TID Cond",
  "Conflict Resolution",
] as const;

const NODE_BOOLEAN_FIELDS = [
  "Parallel Aware",
  "Async Capable",
  "Single Copy",
] as const;

const NODE_STRING_ARRAY_FIELDS = [
  "Output",
  "Sort Key",
  "Presorted Key",
  "Group Key",
  "Hash Key",
  "Conflict Arbiter Indexes",
] as const;

interface ValidationContext {
  readonly limits: PlanValidationLimits;
  readonly issues: PlanValidationIssue[];
}

interface JsonFrame {
  readonly value: unknown;
  readonly path: readonly ValidationPathSegment[];
  readonly depth: number;
}

interface PlanNodeFrame {
  readonly value: unknown;
  readonly path: readonly ValidationPathSegment[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function addIssue(
  context: ValidationContext,
  issue: PlanValidationIssue,
): void {
  if (context.issues.length < context.limits.maxIssues) {
    context.issues.push(issue);
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : fallback;
}

function resolveLimits(
  overrides: Partial<PlanValidationLimits> | undefined,
): PlanValidationLimits {
  return {
    maxInputBytes: normalizeLimit(
      overrides?.maxInputBytes,
      DEFAULT_PLAN_VALIDATION_LIMITS.maxInputBytes,
    ),
    maxDepth: normalizeLimit(
      overrides?.maxDepth,
      DEFAULT_PLAN_VALIDATION_LIMITS.maxDepth,
    ),
    maxNodes: normalizeLimit(
      overrides?.maxNodes,
      DEFAULT_PLAN_VALIDATION_LIMITS.maxNodes,
    ),
    maxValues: normalizeLimit(
      overrides?.maxValues,
      DEFAULT_PLAN_VALIDATION_LIMITS.maxValues,
    ),
    maxIssues: normalizeLimit(
      overrides?.maxIssues,
      DEFAULT_PLAN_VALIDATION_LIMITS.maxIssues,
    ),
  };
}

function validateJsonValue(root: unknown, context: ValidationContext): void {
  const stack: JsonFrame[] = [{ value: root, path: [], depth: 0 }];
  const seenObjects = new WeakSet<object>();
  let visitedValues = 0;

  while (stack.length > 0 && context.issues.length < context.limits.maxIssues) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }

    visitedValues += 1;
    if (visitedValues > context.limits.maxValues) {
      addIssue(context, {
        code: "value-limit-exceeded",
        path: frame.path,
        message: `Plan exceeds the limit of ${context.limits.maxValues} JSON values.`,
      });
      return;
    }

    if (frame.depth > context.limits.maxDepth) {
      addIssue(context, {
        code: "depth-limit-exceeded",
        path: frame.path,
        message: `Plan exceeds the maximum JSON depth of ${context.limits.maxDepth}.`,
      });
      continue;
    }

    const { value } = frame;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        addIssue(context, {
          code: "non-finite-number",
          path: frame.path,
          message: "JSON numeric values must be finite.",
        });
      }
      continue;
    }

    if (typeof value !== "object") {
      addIssue(context, {
        code: "invalid-json-value",
        path: frame.path,
        message: `Values of type ${typeof value} are not valid JSON.`,
      });
      continue;
    }

    if (seenObjects.has(value)) {
      addIssue(context, {
        code: "invalid-json-value",
        path: frame.path,
        message: "Repeated or circular object references are not accepted.",
      });
      continue;
    }
    seenObjects.add(value);

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: value[index],
          path: [...frame.path, index],
          depth: frame.depth + 1,
        });
      }
      continue;
    }

    if (!isRecord(value)) {
      addIssue(context, {
        code: "invalid-json-value",
        path: frame.path,
        message: "Only plain objects are valid JSON objects.",
      });
      continue;
    }

    const keys = Object.keys(value);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key !== undefined) {
        stack.push({
          value: value[key],
          path: [...frame.path, key],
          depth: frame.depth + 1,
        });
      }
    }
  }
}

function validateNumberField(
  record: Record<string, unknown>,
  key: string,
  path: readonly ValidationPathSegment[],
  context: ValidationContext,
): void {
  if (!hasOwn(record, key)) {
    return;
  }

  const value = record[key];
  if (typeof value !== "number") {
    addIssue(context, {
      code: "invalid-field-type",
      path: [...path, key],
      message: `${key} must be a number when present.`,
    });
  } else if (!Number.isFinite(value)) {
    addIssue(context, {
      code: "non-finite-number",
      path: [...path, key],
      message: `${key} must be finite.`,
    });
  }
}

function validateStringField(
  record: Record<string, unknown>,
  key: string,
  path: readonly ValidationPathSegment[],
  context: ValidationContext,
): void {
  if (hasOwn(record, key) && typeof record[key] !== "string") {
    addIssue(context, {
      code: "invalid-field-type",
      path: [...path, key],
      message: `${key} must be a string when present.`,
    });
  }
}

function validateBooleanField(
  record: Record<string, unknown>,
  key: string,
  path: readonly ValidationPathSegment[],
  context: ValidationContext,
): void {
  if (hasOwn(record, key) && typeof record[key] !== "boolean") {
    addIssue(context, {
      code: "invalid-field-type",
      path: [...path, key],
      message: `${key} must be a boolean when present.`,
    });
  }
}

function validateStringArrayField(
  record: Record<string, unknown>,
  key: string,
  path: readonly ValidationPathSegment[],
  context: ValidationContext,
): void {
  if (!hasOwn(record, key)) {
    return;
  }

  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    addIssue(context, {
      code: "invalid-field-type",
      path: [...path, key],
      message: `${key} must be an array of strings when present.`,
    });
  }
}

function validateWorker(
  value: unknown,
  path: readonly ValidationPathSegment[],
  context: ValidationContext,
): void {
  if (!isRecord(value)) {
    addIssue(context, {
      code: "expected-object",
      path,
      message: "Each Workers entry must be an object.",
    });
    return;
  }

  for (const key of NODE_NUMBER_FIELDS) {
    validateNumberField(value, key, path, context);
  }
  validateNumberField(value, "Worker Number", path, context);
  validateStringField(value, "Sort Method", path, context);
  validateStringField(value, "Sort Space Type", path, context);
}

function validateNode(
  record: Record<string, unknown>,
  path: readonly ValidationPathSegment[],
  context: ValidationContext,
): void {
  if (!hasOwn(record, "Node Type")) {
    addIssue(context, {
      code: "missing-field",
      path: [...path, "Node Type"],
      message: "Every plan node requires a Node Type.",
    });
  }

  for (const key of NODE_STRING_FIELDS) {
    validateStringField(record, key, path, context);
  }
  for (const key of NODE_NUMBER_FIELDS) {
    validateNumberField(record, key, path, context);
  }
  for (const key of NODE_BOOLEAN_FIELDS) {
    validateBooleanField(record, key, path, context);
  }
  for (const key of NODE_STRING_ARRAY_FIELDS) {
    validateStringArrayField(record, key, path, context);
  }

  if (hasOwn(record, "Workers")) {
    const workers = record["Workers"];
    if (!Array.isArray(workers)) {
      addIssue(context, {
        code: "invalid-field-type",
        path: [...path, "Workers"],
        message: "Workers must be an array when present.",
      });
    } else {
      workers.forEach((worker, index) => {
        validateWorker(worker, [...path, "Workers", index], context);
      });
    }
  }
}

function validatePlanTree(
  root: unknown,
  rootPath: readonly ValidationPathSegment[],
  context: ValidationContext,
): void {
  const stack: PlanNodeFrame[] = [{ value: root, path: rootPath }];
  let nodeCount = 0;

  while (stack.length > 0 && context.issues.length < context.limits.maxIssues) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }

    nodeCount += 1;
    if (nodeCount > context.limits.maxNodes) {
      addIssue(context, {
        code: "node-limit-exceeded",
        path: frame.path,
        message: `Plan exceeds the limit of ${context.limits.maxNodes} nodes.`,
      });
      return;
    }

    if (!isRecord(frame.value)) {
      addIssue(context, {
        code: "expected-object",
        path: frame.path,
        message: "Each plan node must be an object.",
      });
      continue;
    }

    validateNode(frame.value, frame.path, context);

    if (!hasOwn(frame.value, "Plans")) {
      continue;
    }

    const children = frame.value["Plans"];
    if (!Array.isArray(children)) {
      addIssue(context, {
        code: "invalid-field-type",
        path: [...frame.path, "Plans"],
        message: "Plans must be an array when present.",
      });
      continue;
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        value: children[index],
        path: [...frame.path, "Plans", index],
      });
    }
  }
}

function validateOptionalObject(
  record: Record<string, unknown>,
  key: string,
  path: readonly ValidationPathSegment[],
  context: ValidationContext,
): Record<string, unknown> | null {
  if (!hasOwn(record, key)) {
    return null;
  }

  const value = record[key];
  if (!isRecord(value)) {
    addIssue(context, {
      code: "invalid-field-type",
      path: [...path, key],
      message: `${key} must be an object when present.`,
    });
    return null;
  }

  return value;
}

function validateEnvelope(
  envelope: Record<string, unknown>,
  context: ValidationContext,
): void {
  const path: readonly ValidationPathSegment[] = [0];

  for (const key of ENVELOPE_NUMBER_FIELDS) {
    validateNumberField(envelope, key, path, context);
  }

  if (!hasOwn(envelope, "Plan")) {
    addIssue(context, {
      code: "missing-field",
      path: [0, "Plan"],
      message: "The EXPLAIN envelope requires a Plan object.",
    });
  } else {
    validatePlanTree(envelope["Plan"], [0, "Plan"], context);
  }

  const planning = validateOptionalObject(
    envelope,
    "Planning",
    path,
    context,
  );
  if (planning !== null) {
    for (const key of NODE_NUMBER_FIELDS) {
      validateNumberField(planning, key, [...path, "Planning"], context);
    }
  }

  const jit = validateOptionalObject(envelope, "JIT", path, context);
  if (jit !== null) {
    validateNumberField(jit, "Functions", [...path, "JIT"], context);
    const timing = validateOptionalObject(
      jit,
      "Timing",
      [...path, "JIT"],
      context,
    );
    if (timing !== null) {
      for (const key of [
        "Generation",
        "Inlining",
        "Optimization",
        "Emission",
        "Total",
      ]) {
        validateNumberField(timing, key, [...path, "JIT", "Timing"], context);
      }
    }
    const options = validateOptionalObject(
      jit,
      "Options",
      [...path, "JIT"],
      context,
    );
    if (options !== null) {
      for (const key of [
        "Inlining",
        "Optimization",
        "Expressions",
        "Deforming",
      ]) {
        validateBooleanField(options, key, [...path, "JIT", "Options"], context);
      }
    }
  }

  validateOptionalObject(envelope, "Settings", path, context);

  if (hasOwn(envelope, "Triggers")) {
    const triggers = envelope["Triggers"];
    if (!Array.isArray(triggers)) {
      addIssue(context, {
        code: "invalid-field-type",
        path: [0, "Triggers"],
        message: "Triggers must be an array when present.",
      });
    } else {
      triggers.forEach((trigger, index) => {
        const triggerPath = [0, "Triggers", index] as const;
        if (!isRecord(trigger)) {
          addIssue(context, {
            code: "expected-object",
            path: triggerPath,
            message: "Each Triggers entry must be an object.",
          });
          return;
        }
        for (const key of [
          "Trigger Name",
          "Constraint Name",
          "Relation",
        ]) {
          validateStringField(trigger, key, triggerPath, context);
        }
        for (const key of ["Time", "Calls"]) {
          validateNumberField(trigger, key, triggerPath, context);
        }
      });
    }
  }
}

/**
 * Parse and validate user-pasted PostgreSQL FORMAT JSON without throwing.
 *
 * Validation is intentionally permissive toward unknown keys but strict about
 * JSON safety, PostgreSQL's envelope/tree shape, and types of known fields.
 * The successful value is returned directly, so extension fields are retained.
 */
export function parseRawPostgresPlan(
  input: unknown,
  limitOverrides?: Partial<PlanValidationLimits>,
): PlanValidationResult {
  try {
    const limits = resolveLimits(limitOverrides);
    const context: ValidationContext = { limits, issues: [] };
    let parsed: unknown = input;
    if (typeof input === "string") {
      const inputBytes = new TextEncoder().encode(input).byteLength;
      if (inputBytes > limits.maxInputBytes) {
        return {
          success: false,
          issues: [
            {
              code: "input-too-large",
              path: [],
              message: `Input is ${inputBytes} bytes; the limit is ${limits.maxInputBytes}.`,
            },
          ],
        };
      }

      try {
        parsed = JSON.parse(input) as unknown;
      } catch (error: unknown) {
        const detail =
          error instanceof Error ? ` ${error.message}` : "";
        return {
          success: false,
          issues: [
            {
              code: "invalid-json",
              path: [],
              message: `Input is not valid JSON.${detail}`,
            },
          ],
        };
      }
    }

    validateJsonValue(parsed, context);

    if (!Array.isArray(parsed)) {
      addIssue(context, {
        code: "invalid-root",
        path: [],
        message:
          "PostgreSQL FORMAT JSON output must be a one-element array.",
      });
    } else if (parsed.length !== 1) {
      addIssue(context, {
        code: "invalid-root-length",
        path: [],
        message: `Expected exactly one EXPLAIN envelope; received ${parsed.length}.`,
      });
    } else if (!isRecord(parsed[0])) {
      addIssue(context, {
        code: "expected-object",
        path: [0],
        message: "The EXPLAIN array entry must be an object.",
      });
    } else {
      validateEnvelope(parsed[0], context);
    }

    if (context.issues.length > 0) {
      return { success: false, issues: context.issues };
    }

    return { success: true, data: parsed as unknown as RawPostgresPlan };
  } catch (error: unknown) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    return {
      success: false,
      issues: [
        {
          code: "unexpected-access-error",
          path: [],
          message: `The payload could not be safely inspected.${detail}`,
        },
      ],
    };
  }
}

/** Render a structured issue path in familiar JavaScript notation. */
export function formatValidationPath(
  path: readonly ValidationPathSegment[],
): string {
  let result = "$";
  for (const segment of path) {
    if (typeof segment === "number") {
      result += `[${segment}]`;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      result += `.${segment}`;
    } else {
      result += `[${JSON.stringify(segment)}]`;
    }
  }
  return result;
}
