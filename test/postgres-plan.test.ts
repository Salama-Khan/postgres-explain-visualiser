import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createChildTreePath,
  createConfidenceScore,
  createPlanNodeId,
  formatValidationPath,
  parsePlanNodeId,
  parseRawPostgresPlan,
  type DiagnosticFinding,
  type PlanTreePath,
} from "../src/domain/index.js";
import { pg12ExplainFixture } from "./fixtures/pg12-explain.js";
import { pg18ExplainFixture } from "./fixtures/pg18-explain.js";

function expectSuccess(input: unknown) {
  const result = parseRawPostgresPlan(input);
  if (!result.success) {
    assert.fail(
      `Expected validation success, received: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.data;
}

test("accepts a PostgreSQL 12 plan and preserves extension fields", () => {
  const plan = expectSuccess(JSON.stringify(pg12ExplainFixture));
  const envelope = plan[0];

  assert.deepEqual(envelope["Acme Envelope"], {
    Version: 1,
    Labels: ["analytics", "nightly"],
  });

  const scan = envelope.Plan.Plans?.[0]?.Plans?.[0];
  assert.ok(scan);
  assert.deepEqual(scan["Acme Scan Statistics"], {
    "Remote Cache Hits": 7,
    Provider: "acme_fdw",
  });
  assert.equal(scan.Workers?.length, 2);
  assert.equal(envelope.JIT?.Timing?.Total, 2.84);
});

test("accepts a PostgreSQL 18 plan with planning and spill details", () => {
  const plan = expectSuccess(pg18ExplainFixture);
  const envelope = plan[0];

  // Parsed objects are returned directly; validation never strips properties.
  assert.strictEqual(plan, pg18ExplainFixture);
  assert.equal(envelope["Serialization Time"], 1.08);
  assert.equal(envelope.Plan["Sort Space Type"], "Disk");
  assert.equal(envelope.Plan["Temp Written Blocks"], 2312);
  assert.deepEqual(envelope.Plan["PG18 Experimental Detail"], {
    Enabled: true,
    Samples: [1, 2, 3],
  });
  assert.deepEqual(envelope.Planning?.["Planning Memory"], {
    "Memory Used": 384,
    "Memory Allocated": 512,
  });
});

test("accepts plans without ANALYZE, BUFFERS, TIMING, or COSTS fields", () => {
  const plan = expectSuccess([
    {
      Plan: {
        "Node Type": "Result",
        Output: ["1"],
      },
    },
  ]);

  assert.equal(plan[0].Plan["Node Type"], "Result");
  assert.equal(plan[0].Plan["Actual Total Time"], undefined);
});

test("rejects invalid JSON, wrappers, double encoding, and multiple roots", () => {
  const invalidJson = parseRawPostgresPlan("[{");
  assert.equal(invalidJson.success, false);
  if (!invalidJson.success) {
    assert.equal(invalidJson.issues[0]?.code, "invalid-json");
  }

  const wrapped = parseRawPostgresPlan({
    "QUERY PLAN": pg12ExplainFixture,
  });
  assert.equal(wrapped.success, false);
  if (!wrapped.success) {
    assert.ok(wrapped.issues.some((issue) => issue.code === "invalid-root"));
  }

  const doubleEncoded = parseRawPostgresPlan(
    JSON.stringify(JSON.stringify(pg12ExplainFixture)),
  );
  assert.equal(doubleEncoded.success, false);
  if (!doubleEncoded.success) {
    assert.ok(
      doubleEncoded.issues.some((issue) => issue.code === "invalid-root"),
    );
  }

  const multipleRoots = parseRawPostgresPlan([
    { Plan: { "Node Type": "Result" } },
    { Plan: { "Node Type": "Result" } },
  ]);
  assert.equal(multipleRoots.success, false);
  if (!multipleRoots.success) {
    assert.ok(
      multipleRoots.issues.some(
        (issue) => issue.code === "invalid-root-length",
      ),
    );
  }
});

test("reports malformed known fields and invalid child nodes with paths", () => {
  const result = parseRawPostgresPlan([
    {
      Plan: {
        "Node Type": 42,
        "Actual Rows": "many",
        "Parallel Aware": "yes",
        Output: ["id", 7],
        Workers: [{}],
        Plans: [null],
      },
      JIT: {
        Functions: "four",
        Options: { Inlining: "false" },
      },
      Triggers: "none",
    },
  ]);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.issues.length >= 7);
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.code === "invalid-field-type" &&
          formatValidationPath(issue.path) === '$[0].Plan["Node Type"]',
      ),
    );
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.code === "expected-object" &&
          formatValidationPath(issue.path) === "$[0].Plan.Plans[0]",
      ),
    );
  }
});

test("rejects non-JSON values, non-finite numbers, and unsafe access", () => {
  const nonFinite = parseRawPostgresPlan([
    {
      Plan: {
        "Node Type": "Result",
        "Actual Total Time": Number.POSITIVE_INFINITY,
        Extension: undefined,
      },
    },
  ]);
  assert.equal(nonFinite.success, false);
  if (!nonFinite.success) {
    assert.ok(
      nonFinite.issues.some((issue) => issue.code === "non-finite-number"),
    );
    assert.ok(
      nonFinite.issues.some((issue) => issue.code === "invalid-json-value"),
    );
  }

  const envelope: Record<string, unknown> = {};
  Object.defineProperty(envelope, "Plan", {
    enumerable: true,
    get(): never {
      throw new Error("getter should be contained");
    },
  });
  const hostile = parseRawPostgresPlan([envelope]);
  assert.equal(hostile.success, false);
  if (!hostile.success) {
    assert.equal(hostile.issues[0]?.code, "unexpected-access-error");
  }

  const hostileLimits = new Proxy(
    {},
    {
      get(): never {
        throw new Error("limit getter should be contained");
      },
    },
  );
  const guardedLimits = parseRawPostgresPlan(
    [{ Plan: { "Node Type": "Result" } }],
    hostileLimits,
  );
  assert.equal(guardedLimits.success, false);
  if (!guardedLimits.success) {
    assert.equal(guardedLimits.issues[0]?.code, "unexpected-access-error");
  }
});

test("enforces byte, depth, node, and total-value limits", () => {
  const oversized = parseRawPostgresPlan(
    JSON.stringify([{ Plan: { "Node Type": "Result" } }]),
    { maxInputBytes: 10 },
  );
  assert.equal(oversized.success, false);
  if (!oversized.success) {
    assert.equal(oversized.issues[0]?.code, "input-too-large");
  }

  let nested: unknown = "leaf";
  for (let index = 0; index < 10; index += 1) {
    nested = { nested };
  }
  const tooDeep = parseRawPostgresPlan(
    [{ Plan: { "Node Type": "Result", Extension: nested } }],
    { maxDepth: 5 },
  );
  assert.equal(tooDeep.success, false);
  if (!tooDeep.success) {
    assert.ok(
      tooDeep.issues.some(
        (issue) => issue.code === "depth-limit-exceeded",
      ),
    );
  }

  const tooManyNodes = parseRawPostgresPlan(
    [
      {
        Plan: {
          "Node Type": "Append",
          Plans: [
            { "Node Type": "Result" },
            { "Node Type": "Result" },
          ],
        },
      },
    ],
    { maxNodes: 2 },
  );
  assert.equal(tooManyNodes.success, false);
  if (!tooManyNodes.success) {
    assert.ok(
      tooManyNodes.issues.some(
        (issue) => issue.code === "node-limit-exceeded",
      ),
    );
  }

  const tooManyValues = parseRawPostgresPlan(
    [{ Plan: { "Node Type": "Result", Extension: [1, 2, 3, 4] } }],
    { maxValues: 4 },
  );
  assert.equal(tooManyValues.success, false);
  if (!tooManyValues.success) {
    assert.ok(
      tooManyValues.issues.some(
        (issue) => issue.code === "value-limit-exceeded",
      ),
    );
  }
});

test("creates deterministic typed IDs and rejects invalid IDs", () => {
  const rootPath: PlanTreePath = [0];
  const childPath = createChildTreePath(rootPath, 2);
  const grandchildPath = createChildTreePath(childPath, 1);

  assert.equal(createPlanNodeId(rootPath), "0");
  assert.equal(createPlanNodeId(grandchildPath), "0.2.1");
  assert.equal(parsePlanNodeId("0.2.1"), "0.2.1");
  assert.equal(parsePlanNodeId("1.2"), null);
  assert.equal(parsePlanNodeId("0.01"), null);
  assert.throws(() => createChildTreePath(rootPath, -1), RangeError);
});

test("models auditable diagnostic evidence with bounded confidence", () => {
  const rootId = createPlanNodeId([0]);
  const finding: DiagnosticFinding = {
    ruleId: "row-estimate-error",
    severity: "warning",
    confidence: createConfidenceScore(0.95),
    summary: "Actual rows were 20 times the estimate.",
    primaryNodeId: rootId,
    affectedNodeIds: [rootId],
    evidence: [
      {
        formula: "actualRowsPerLoop / estimatedRows",
        operands: [
          {
            name: "actualRowsPerLoop",
            value: 20_000,
            unit: "rows",
            source: {
              nodeId: rootId,
              rawPath: "/0/Plan",
              field: "Actual Rows",
            },
          },
          {
            name: "estimatedRows",
            value: 1_000,
            unit: "rows",
            source: {
              nodeId: rootId,
              rawPath: "/0/Plan",
              field: "Plan Rows",
            },
          },
        ],
        result: 20,
        unit: "ratio",
        threshold: {
          operator: ">=",
          value: 10,
          unit: "ratio",
        },
      },
    ],
  };

  assert.equal(finding.evidence[0]?.result, 20);
  assert.throws(() => createConfidenceScore(1.01), RangeError);
  assert.throws(() => createConfidenceScore(Number.NaN), RangeError);
});
