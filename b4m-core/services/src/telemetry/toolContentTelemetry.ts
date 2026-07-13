import type { CitableSource } from '@bike4mind/common';

export interface WebFetchContentTelemetry {
  /** Invocations whose extracted content was truncated at the size cap. */
  truncatedInvocationCount: number;
  /** Sum of extracted (post-cap) content length across web_fetch citables. */
  totalExtractedChars: number;
  /** Largest single extracted (post-cap) content length. */
  maxExtractedChars: number;
}

/**
 * Aggregate per-invocation content-size + truncation metrics for the web_fetch tool
 * from the citables it emitted. Each web_fetch citable carries metadata.contentLength
 * and metadata.truncated (see the webfetch tool / issue #452), so the rollup reads them
 * rather than needing a separate per-call telemetry channel.
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
