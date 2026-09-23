/**
 * POST /api/diagnose
 *
 * I accept a single `DiagnosticFinding` (produced by the rules engine) and the
 * plan node type, then stream a concise DBA-level explanation back to the
 * caller using the Vercel AI SDK and the OpenAI `gpt-4o-mini` model.
 *
 * Stream contract
 * ---------------
 * I return `streamText(...).toDataStreamResponse()` which emits the Vercel AI
 * data-stream protocol.  The `useCompletion` hook on the client understands
 * this protocol and appends each chunk to its `completion` string in real time.
 *
 * Error strategy
 * --------------
 * I never throw across the HTTP boundary.  If the API key is absent I return
 * HTTP 503 with a JSON body.  If the request body is malformed I return 400.
 * If the upstream OpenAI call fails I return 502.  None of these paths crash
 * the Next.js worker process.
 */

import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import type { NextRequest } from "next/server";
import type { DiagnosticFinding } from "../../../domain/postgres-plan";

// ---------------------------------------------------------------------------
// System prompt — I keep the model grounded in the provided evidence
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a Staff Database Administrator specialising in PostgreSQL query optimisation and performance analysis.

When given a diagnostic finding from an EXPLAIN plan analyser, you will:
1. Explain concisely (3–5 sentences) WHY the specific metric described in the evidence causes a performance bottleneck. Ground your explanation in the exact numbers supplied — do not round, adjust, or extrapolate them.
2. If a scrubbed SQL condition is present in the summary (shown as ? placeholders for literals), reference it to make the explanation contextual and specific to this query pattern.
3. Conclude with a single, concrete, actionable recommendation (e.g. "Add a partial index on column X", "Run ANALYZE on table Y", "Increase shared_buffers to Z").

Hard constraints:
- You MUST NOT invent table names, column names, index names, row counts, timing values, or any metric not explicitly present in the finding below.
- You MUST NOT use markdown headers or bullet lists. Respond in plain prose only.
- You MUST NOT qualify your answer with phrases like "based on the evidence provided" — write as a practitioner who read the plan directly.
- Keep the response under 120 words.`;

// ---------------------------------------------------------------------------
// Prompt builder — I serialise the finding into a structured LLM message
// ---------------------------------------------------------------------------

/**
 * I format the `DiagnosticFinding` into a dense but readable user message.
 * The model receives the exact formula, every operand with its unit and value,
 * the computed result, and the threshold it breached — no inference needed.
 */
function buildUserPrompt(finding: DiagnosticFinding, nodeType: string): string {
  const evidenceBlock = finding.evidence
    .map((ev) => {
      const operandLines = ev.operands
        .map((op) => `  ${op.name} = ${op.value} (${op.unit})`)
        .join("\n");

      const thresholdLine = ev.threshold
        ? `  threshold: result ${ev.threshold.operator} ${ev.threshold.value} ${ev.threshold.unit}`
        : "  threshold: none";

      return [
        `formula:    ${ev.formula}`,
        `operands:\n${operandLines}`,
        `result:     ${ev.result} ${ev.unit}`,
        thresholdLine,
      ].join("\n");
    })
    .join("\n\n");

  return [
    `node type:  ${nodeType}`,
    `rule:       ${finding.ruleId}`,
    `severity:   ${finding.severity}`,
    `confidence: ${(finding.confidence * 100).toFixed(0)}%`,
    ``,
    `summary:    ${finding.summary}`,
    ``,
    `evidence:`,
    evidenceBlock,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  // I check for the API key before attempting to open any network connection
  if (!process.env["OPENAI_API_KEY"]) {
    return new Response(
      JSON.stringify({
        error:
          "OPENAI_API_KEY is not configured. Add it to .env.local and restart the dev server.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  // I parse and validate the request body
  let finding: DiagnosticFinding;
  let nodeType: string;

  try {
    // I cast through unknown so TypeScript does not complain about the open JSON type
    const body = (await req.json()) as unknown as {
      finding: DiagnosticFinding;
      nodeType: string;
    };

    finding = body.finding;
    nodeType = body.nodeType;

    if (
      typeof finding !== "object" ||
      finding === null ||
      typeof nodeType !== "string" ||
      nodeType.length === 0
    ) {
      return new Response(
        JSON.stringify({
          error: "Request body must include a `finding` object and a `nodeType` string.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  } catch {
    // I swallow the parse error and return a clean 400 rather than letting it bubble
    return new Response(
      JSON.stringify({ error: "Request body is not valid JSON." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // I attempt the stream and surface any provider-side errors as 502
  try {
    const result = streamText({
      model: openai("gpt-4o-mini"),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(finding, nodeType),
      // I cap output tokens aggressively — the answer must stay concise
      maxOutputTokens: 180,
      // I use a low temperature so the model stays anchored to the evidence
      temperature: 0.25,
    });

    // I use toTextStreamResponse — toDataStreamResponse was removed in ai@6
    return result.toTextStreamResponse();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Upstream stream failed.";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
