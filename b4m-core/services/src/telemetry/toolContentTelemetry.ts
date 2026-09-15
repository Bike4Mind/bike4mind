import type { CitableSource } from '@bike4mind/common';

export interface WebFetchContentTelemetry {
  /**
   * Count of unique truncated web_fetch citables. Citables dedupe by url
   * (ToolBuilder.applyQuestStatusChanges), so repeated fetches of the SAME url within one
   * completion collapse to one citable - this can under-count same-url refetches. Distinct
   * urls each count. (Same-url refetch in a single turn is rare, so the skew is small.)
   */
  truncatedInvocationCount: number;
  /** Sum of extracted (post-cap) content length across unique web_fetch citables. */
  totalExtractedChars: number;
  /** Largest single extracted (post-cap) content length. */
  maxExtractedChars: number;
}

/**
 * Aggregate content-size + truncation metrics for the web_fetch tool from the citables it
 * emitted. Each web_fetch citable carries metadata.contentLength and metadata.truncated
 * (see the webfetch tool / issue #452), so the rollup reads them rather than needing a
 * separate per-call telemetry channel. Note the citables are already deduped by url upstream,
 * so counts are per-unique-citable, not per-raw-invocation (see truncatedInvocationCount).
 */
export function aggregateWebFetchContentTelemetry(
  citables: readonly CitableSource[] | undefined
): WebFetchContentTelemetry {
  let truncatedInvocationCount = 0;
  let totalExtractedChars = 0;
  let maxExtractedChars = 0;

  for (const citable of citables ?? []) {
    if (citable.metadata?.sourceSystem !== 'web_fetch') continue;
    const chars = typeof citable.metadata?.contentLength === 'number' ? citable.metadata.contentLength : 0;
    totalExtractedChars += chars;
    maxExtractedChars = Math.max(maxExtractedChars, chars);
    if (citable.metadata?.truncated === true) truncatedInvocationCount++;
  }

  return { truncatedInvocationCount, totalExtractedChars, maxExtractedChars };
}
