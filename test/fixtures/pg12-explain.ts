/**
 * Representative PostgreSQL 12 ANALYZE/BUFFERS payload.
 *
 * It exercises parallel worker details, per-loop metrics, JIT, and unknown
 * extension fields without claiming to be a byte-for-byte server snapshot.
 */
export const pg12ExplainFixture: unknown = [
  {
    Plan: {
      "Node Type": "Aggregate",
      Strategy: "Plain",
      "Parallel Aware": false,
      "Startup Cost": 10633.55,
      "Total Cost": 10633.56,
      "Plan Rows": 1,
      "Plan Width": 8,
      "Actual Startup Time": 35.301,
      "Actual Total Time": 35.304,
      "Actual Rows": 1,
      "Actual Loops": 1,
      "Shared Hit Blocks": 128,
      "Shared Read Blocks": 64,
      Plans: [
        {
          "Node Type": "Gather",
          "Parent Relationship": "Outer",
          "Parallel Aware": false,
          "Workers Planned": 2,
          "Workers Launched": 2,
          "Actual Startup Time": 0.412,
          "Actual Total Time": 31.182,
          "Actual Rows": 3,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Parent Relationship": "Outer",
              "Parallel Aware": true,
              "Relation Name": "events",
              Schema: "public",
              Alias: "events",
              Filter: "(created_at >= '2020-01-01'::date)",
              "Rows Removed by Filter": 1200,
              "Actual Startup Time": 0.018,
              "Actual Total Time": 28.602,
              "Actual Rows": 4000,
              "Actual Loops": 3,
              "Shared Hit Blocks": 128,
              "Shared Read Blocks": 64,
              Workers: [
                {
                  "Worker Number": 0,
                  "Actual Startup Time": 0.02,
                  "Actual Total Time": 27.9,
                  "Actual Rows": 3900,
                  "Actual Loops": 1,
                  "Shared Hit Blocks": 43,
                  "Shared Read Blocks": 21,
                },
                {
                  "Worker Number": 1,
                  "Actual Startup Time": 0.021,
                  "Actual Total Time": 28.1,
                  "Actual Rows": 4010,
                  "Actual Loops": 1,
                  "Shared Hit Blocks": 42,
                  "Shared Read Blocks": 22,
                },
              ],
              "Acme Scan Statistics": {
                "Remote Cache Hits": 7,
                Provider: "acme_fdw",
              },
            },
          ],
        },
      ],
    },
    "Planning Time": 0.248,
    "Execution Time": 35.612,
    Triggers: [],
    JIT: {
      Functions: 4,
      Options: {
        Inlining: false,
        Optimization: false,
        Expressions: true,
        Deforming: true,
      },
      Timing: {
        Generation: 0.44,
        Inlining: 0,
        Optimization: 0.22,
        Emission: 2.18,
        Total: 2.84,
      },
    },
    "Acme Envelope": {
      Version: 1,
      Labels: ["analytics", "nightly"],
    },
  },
];
