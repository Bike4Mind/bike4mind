import type { PerformanceTelemetry } from '@bike4mind/common';

/** The subset of promptMeta.performance this mapping reads. */
export interface PromptMetaPerformance {
  firstTokenTime?: number;
  firstChunkTime?: number;
  modelInferenceTime?: number;
}

/**
 * Maps a quest's promptMeta.performance onto the telemetry performance section.
 *
 * The TTFVT pair rides through unaltered: an absent firstTokenTime is the never-rendered
 * signal computeAnomalies needs, so it must stay undefined rather than default to 0, which
 * would read as fast. firstChunkTime is what proves the turn streamed at all - see ttfvt.ts.
 */
export function performanceFromPromptMeta(
  promptPerf: PromptMetaPerformance | undefined,
  totalResponseTimeMs: number
): Partial<PerformanceTelemetry> {
  return {
    totalResponseTimeMs,
    modelInferenceMs: promptPerf?.modelInferenceTime,
    firstTokenTimeMs: promptPerf?.firstTokenTime,
    firstChunkTimeMs: promptPerf?.firstChunkTime,
  };
}
