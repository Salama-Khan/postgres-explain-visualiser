# Postgres EXPLAIN Visualiser

Paste the JSON from `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and get a plan tree plus deterministic diagnostics.

The app never connects to a database and never runs SQL. The only input is pasted plan JSON.

## Run locally

Requires Node 20+.

```bash
npm install
npm run dev
```

Open the URL Next prints (usually `http://localhost:3000`). Paste a one-element Postgres array — it must start with `[` — and click **Analyse Plan**.

`OPENAI_API_KEY` is optional. Without it, the graph and rule badges still work. The drawer will skip the streamed write-up.

To add a key:

```bash
echo 'OPENAI_API_KEY=sk-...' > .env.local
```

Do not commit `.env.local`.

## What the rules do

Each finding has a formula, operands, and a threshold. SQL literals in filter text are replaced with `?` before anything is shown or sent to a model.

| Rule | Fires when |
|---|---|
| `diag.row-misestimation` | Actual rows (loop-adjusted) are more than 10× off the planner estimate |
| `diag.high-disk-io` | Buffer cache hit rate is under 80% |
| `diag.large-seq-scan` | A `Seq Scan` processes more than 10,000 rows |

The language model only narrates a finding the rules already produced. It does not invent diagnoses.

Postgres reports `"Actual Rows"` and `"Actual Total Time"` as **per-loop averages**. The adapter multiplies by `"Actual Loops"` (or 1) before the rules run.

## Touchline plans

These two `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` captures are from the Touchline (`footballanalysis`) database — match `15946` and the global 16×12 move-zone aggregate. Paste them from [`fixtures/`](fixtures/).

### 1. Match actions (feeds the player net-xT board)

Query: `events` for one match, `Pass` / `Carry` / `Shot` only, joined to `teams` and `players`, ordered by `event_index`. Source: `GET /api/matches/{id}/analytics` in Touchline. Fixture: [`fixtures/xt-match-actions.json`](fixtures/xt-match-actions.json).

The planner used `idx_events_actor` on `match_id = 15946` (3,762 index rows), then a bitmap heap filter dropped 1,681 non-actions, leaving 2,081. Hash joins to `teams` and `players` were cheap; the sort stayed in memory. `teams` was estimated at 1,270 rows and produced 11 (~115× under), so `diag.row-misestimation` fires on that seq scan — stats on a tiny lookup table, not a slow query. Nothing here is a large seq scan or a cache miss; the board is slow in Python after this result, not in Postgres.

### 2. Events by zone (xT move attempts)

Query: every on-ball `Pass` / `Carry` with a start location, binned into the 16×12 grid (`LEAST(TRUNC(...))`), grouped by `zone_index`. Source: `moves_query()` in Touchline’s `xt_engine.py`. Fixture: [`fixtures/xt-events-by-zone.json`](fixtures/xt-events-by-zone.json).

This is a full-table seq scan: 10,886 rows kept, 10,685 filtered off, 392 shared hits and 0 reads. `diag.large-seq-scan` fires because the scan is over 10,000 rows; `diag.high-disk-io` does not, because the working set was already in `shared_buffers`. The aggregate estimated 2,155 groups and produced 191 zones (~11× over) — a second `diag.row-misestimation` if you click the Aggregate node. What I would change: a partial index on `(type_name)` where location is present, or a generated `zone_index` column, once this query is on the hot path. Today it is a one-shot fit, so a 14 ms scan is acceptable.

## Tests

Parser and ID tests only:

```bash
npm test
```

## Not built yet

These are deliberate gaps, not silent bugs:

- Exclusive time is always `null`. Subtracting child times is unsound under parallel workers and mismatched loop counts.
- Buffer counts stay inclusive. A parent’s `"Shared Hit Blocks"` includes its descendants.
- There is no full-tree `normalizePlan()`. The UI adapts the **clicked** node only.
- `analyzePlan` can walk the tree; the drawer does not use it.
- There are no tests for `analyzeNode` or `scrubSqlLiterals`.

## Stack

Next.js, React Flow, a TypeScript plan parser, and a small rules engine. Optional streaming explanations via the Vercel AI SDK and OpenAI.
