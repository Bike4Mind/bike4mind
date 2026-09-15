import { ELISION_WARNING } from '@bike4mind/common';

/**
 * Rolls per-artifact elision results up into the values persisted on `promptMeta`.
 *
 * Extracted from ChatCompletionProcess so it can be tested directly: that module is a ~3700-line
 * orchestrator with no test file, and this rollup - the cap, the "(+N more)" marker, the
 * once-per-quest warning, the truncation suppression - was corrected three separate times during
 * review with nothing pinning any of it.
 *
 * Pure: no I/O, no logging, no mutation of its inputs.
 */

/** One artifact's verdict, pre-formatted by the caller so detector types stay out of this module. */
export interface ElisionHit {
  confidence: 'high' | 'low';
  /** Human-readable signal descriptions. */
  signals: string[];
}

export interface ElisionStamp {
  suspectedElision: {
    confidence: 'high' | 'low';
    signalCount: number;
    details: string[];
  };
  /** The full replacement `warnings` array, or the prior one unchanged when suppressed. */
  warnings: string[];
}

/**
 * Cap on elision signal descriptions persisted to promptMeta. A heavily stubbed artifact can produce
 * dozens; the client only needs enough to explain the notice, and promptMeta is stored per quest.
 */
export const MAX_ELISION_DETAILS = 10;

/** Per-piece length caps for model-authored text interpolated into `details`. */
export const ELISION_TITLE_MAX = 80;
export const ELISION_MATCH_MAX = 200;
export const ELISION_NAME_MAX = 60;

/** Truncates to `max` characters with a marker, so a clipped detail never reads as complete. */
export function truncateElisionText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...[truncated]`;
}

export function buildElisionStamp(
  hits: ElisionHit[],
  opts: { wasTruncated: boolean; priorWarnings: string[] }
): ElisionStamp | null {
  if (hits.length === 0) return null;

  const confidence = hits.some(hit => hit.confidence === 'high') ? 'high' : 'low';
  const allSignals = hits.flatMap(hit => hit.signals);
  const shown = allSignals.slice(0, MAX_ELISION_DETAILS);
  const omitted = allSignals.length - shown.length;

  // The user-facing warning is suppressed when the response ALSO hit the output ceiling: truncation
  // has its own, more accurate warning and the client already suppresses the elision banner in that
  // case, so stamping both reported one event twice in the debug inspector. `suspectedElision`
  // itself is still returned - it is the diagnostic record, and a truncated response can genuinely
  // contain stub markers too.
  const warnings =
    opts.wasTruncated || opts.priorWarnings.includes(ELISION_WARNING)
      ? opts.priorWarnings
      : [...opts.priorWarnings, ELISION_WARNING];

  return {
    suspectedElision: {
      confidence,
      signalCount: allSignals.length,
      details: omitted > 0 ? [...shown, `(+${omitted} more not shown)`] : shown,
    },
    warnings,
  };
}
