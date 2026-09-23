"use client";

/**
 * useStreamCompletion.ts — I wrap `callCompletionApi` from the Vercel AI SDK
 * (ai@6) into a React hook that mirrors the old `useCompletion` interface.
 *
 * In ai@6 the `useCompletion` React hook was removed; `callCompletionApi` is
 * the exported primitive that underpins it.  I expose the same surface area
 * the drawer needs: `completion`, `isLoading`, `error`, `complete`, and
 * `setCompletion`.
 *
 * I use `streamProtocol: "text"` so the route can return a plain
 * `toTextStreamResponse()` — the data-stream envelope variant was also removed
 * in this SDK version.
 */

import { useCallback, useRef, useState } from "react";
import { callCompletionApi } from "ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamCompletionOptions {
  /** Absolute or relative URL of the POST endpoint. */
  api: string;
  /** Called whenever the provider raises an error so callers can log. */
  onError?: (err: Error) => void;
}

export interface StreamCompletionHelpers {
  /** Accumulated streamed text, appended token-by-token. */
  completion: string;
  /** True while the stream is open and receiving tokens. */
  isLoading: boolean;
  /** Set when the provider or network raises an error. */
  error: Error | undefined;
  /**
   * Send a POST request to `api` and stream the response into `completion`.
   *
   * @param prompt - Forwarded as the `prompt` field in the JSON body.  Pass an
   *                 empty string when the server builds its own prompt from
   *                 the extra `body` fields.
   * @param options.body - Merged into the POST body alongside `prompt`.
   */
  complete: (
    prompt: string,
    options?: { body?: Record<string, unknown> },
  ) => Promise<void>;
  /** Overwrite `completion` directly — useful for clearing on node change. */
  setCompletion: (value: string) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useStreamCompletion(
  options: StreamCompletionOptions,
): StreamCompletionHelpers {
  const { api, onError } = options;

  const [completion, setCompletion] = useState<string>("");
  const [isLoading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  // I keep the AbortController in a ref rather than state so updating it
  // never triggers a re-render.
  const abortControllerRef = useRef<AbortController | null>(null);

  const complete = useCallback(
    async (
      prompt: string,
      callOptions?: { body?: Record<string, unknown> },
    ): Promise<void> => {
      // I reset the error before each new request
      setError(undefined);

      await callCompletionApi({
        api,
        prompt,
        credentials: undefined,
        headers: undefined,
        // I spread the extra body fields so the server receives finding + nodeType
        body: (callOptions?.body ?? {}) as Record<string, unknown>,
        // I use the plain text protocol because toTextStreamResponse() is the
        // available method in this SDK version (toDataStreamResponse was removed)
        streamProtocol: "text",
        setCompletion,
        setLoading,
        setError,
        setAbortController: (controller) => {
          abortControllerRef.current = controller;
        },
        onFinish: undefined,
        onError,
        fetch: undefined,
      });
    },
    [api, onError],
  );

  return { completion, isLoading, error, complete, setCompletion };
}
