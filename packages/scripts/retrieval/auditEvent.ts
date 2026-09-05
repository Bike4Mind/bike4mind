/**
 * Reading one lake-audit event as "what did retrieval actually serve".
 *
 * Pure and separated from the live driver because this is the single decision the whole measurement
 * rests on: the same absent-event condition means "correctly served nothing" in one case and "the
 * probe cannot see what was served" in another, and getting that backwards silently reports a
 * healthy configuration as a total recall failure. It needs to be testable without a stage.
 */

import type { PromptMeta, RecordLakeAccessEventInput } from '@bike4mind/common';

/**
 * The fields of a captured `RecordLakeAccessEventInput` this reading depends on.
 *
 * Derived from the producer's own type rather than restated, so an upstream rename of `fileIds` or
 * `scores` is a build error here. Restating them structurally would compile clean, make the probe
 * read `undefined`, and route a healthy semantic result straight into `keyword-fallback` - a
 * confidently wrong diagnosis, which is the one failure mode this module exists to prevent.
 */
export type AuditEventShape = Pick<RecordLakeAccessEventInput, 'fileIds' | 'scores'>;

/**
 * The tool's own notice when a nonzero relevance floor rejected every candidate passage.
 *
 * COUPLED BY TEXT to `knowledgeBaseSearch/index.ts` (both semantic arms build this literal when
 * `budgets.kbMinRelevance > 0 && search.results.length === 0`), because the tool exposes no
 * structural signal for it: the floor-emptied turn and a turn where the semantic arm was never
 * available reach the same keyword-arm status write, and `warnings` is the only field that differs.
 *
 * Drift is safe, not silent. If the wording changes, a floor-emptied turn stops matching, reads as
 * `keyword-fallback`, and ABORTS the sweep with an error - it can never quietly score a wrong row.
 */
export const RELEVANCE_FLOOR_NOTICE = 'a configured relevance threshold filtered out every candidate passage';

/**
 * What the tool's OWN status write says happened, captured from the `statusUpdate` seam.
 *
 * This is what disambiguates an absent audit event. Every terminal path in
 * `search_knowledge_base` awaits a `statusUpdate` carrying `promptMeta.retrieval` before returning
 * (the semantic arm via `emitSemanticCitables`, the keyword arm on both its hit and no-hit
 * branches, and each failure path), so unlike the un-awaited audit write this signal is always
 * present by the time `toolFn` resolves. `citables` is the tool's own record of what reached the
 * model, so its presence separates "served content" from "ran and found nothing".
 */
export type RetrievalStatus =
  /** Retrieval ran to completion and put passages in front of the model. */
  | { kind: 'served-content' }
  /** Retrieval ran to completion and legitimately had nothing to serve. */
  | { kind: 'no-content' }
  /**
   * The semantic arm RAN and the relevance floor under test rejected every candidate. A legitimate
   * served-nothing measurement of the configuration, not a harness failure - see
   * `RELEVANCE_FLOOR_NOTICE`.
   */
  | { kind: 'floor-emptied' }
  /**
   * Retrieval reported a non-ok outcome (`failed`, `no_lakes`, `not_indexed`). Deliberately keyed
   * on "not ok" rather than enumerating them, so an outcome added upstream is a loud stop here
   * instead of a silently scored row.
   */
  | { kind: 'failed'; outcome: string }
  /** No retrieval status was written at all, so the tool did not reach a terminal path. */
  | { kind: 'absent' };

/**
 * The `promptMeta` fields this reading depends on. The tool writes more; none of the rest matters.
 *
 * `Pick`ed from the real `PromptMeta` rather than restated for the same reason as
 * `AuditEventShape`: a rename of `citables`, `warnings` or `retrieval` upstream must break the
 * build here rather than degrade this reading into a wrong diagnosis. `unknown[]` for `citables`
 * because only its length is read, and `outcome`/`warnings` are widened to what this module
 * narrows on.
 */
type SourcePromptMetaFields = Pick<PromptMeta, 'citables' | 'warnings' | 'retrieval'>;
export type CapturedPromptMeta = {
  citables?: unknown[];
  warnings?: string[];
  retrieval?: { outcome?: string };
};
// Fails the build if the source fields drift out of the shape this module reads them in.
const _promptMetaFieldsMatch: (m: SourcePromptMetaFields) => CapturedPromptMeta = m => m;
void _promptMetaFieldsMatch;

/**
 * Collapse the status writes captured across one tool call into the one fact the audit reading
 * needs.
 *
 * The last write carrying `retrieval` is the terminal one: a semantic arm that finds nothing falls
 * through to the keyword arm, which writes its own. `citables` is checked across every write
 * because it is the tool's record of what actually reached the model, and the keyword arm's no-hit
 * branch is the one path that omits it.
 *
 * The floor notice is checked BEFORE `citables` and wins over it. When the floor empties the
 * semantic arm, the keyword fallback still runs and may stamp citables of its own - but those are
 * keyword hits, which neither knob under test governs, so counting them would report the fallback's
 * behaviour as this configuration's. What the sweep is measuring served nothing.
 */
export function readRetrievalStatus(metas: readonly CapturedPromptMeta[]): RetrievalStatus {
  const terminal = [...metas].reverse().find(m => m.retrieval)?.retrieval;
  if (!terminal) return { kind: 'absent' };
  const outcome = terminal.outcome ?? 'unknown';
  if (outcome !== 'ok') return { kind: 'failed', outcome };
  const carriesFloorNotice = metas.some(m => m.warnings?.some(w => w.includes(RELEVANCE_FLOOR_NOTICE)));
  if (carriesFloorNotice) return { kind: 'floor-emptied' };
  return metas.some(m => (m.citables?.length ?? 0) > 0) ? { kind: 'served-content' } : { kind: 'no-content' };
}

export type ServedReading =
  /** Retrieval ran and served these files. */
  | { kind: 'served'; fileIds: string[] }
  /** Retrieval ran and served nothing. On a negative question this is the desired outcome. */
  | { kind: 'nothing' }
  /**
   * The semantic arm was never AVAILABLE and the keyword fallback answered instead - a wiring or
   * credential problem, so the configuration was never exercised and the run must stop rather than
   * report a keyword-search number as a budget-sweep row.
   *
   * Narrower than "the keyword arm answered": the floor emptying an arm that did run is
   * `floor-emptied`, and reads as a legitimate `nothing`. Both reach the same keyword-arm audit
   * row, so only `status` can tell them apart.
   */
  | { kind: 'keyword-fallback' }
  /**
   * The probe cannot say what was served. Never scored - a data point the harness could not
   * observe must surface as an error, not as a zero that reads like a real floor rejection.
   */
  | { kind: 'unmeasurable'; reason: string };

/**
 * `search_knowledge_base` records an audit event from two places (`knowledgeBaseSearch/index.ts`,
 * the semantic arm at ~974 and the keyword arm at ~1224). They are told apart by their PAYLOAD, not
 * their `surface`, which is identical on both:
 *
 * - semantic arm: carries `chunkIds` and per-chunk `scores`.
 * - keyword arm:  carries `fileIds` only, no scores (it is metadata-only, with no chunk ranking).
 *
 * No event at all is AMBIGUOUS on its own, which is why `status` is required. The tool writes no
 * audit row when it served nothing, and the probe's wait for that un-awaited write can also simply
 * time out - the same absence standing for a genuine result and for a harness malfunction. `status`
 * is the tool's own awaited account of which one it was.
 */
export function readServedDocuments(event: AuditEventShape | null | undefined, status: RetrievalStatus): ServedReading {
  if (status.kind === 'absent') {
    return {
      kind: 'unmeasurable',
      reason:
        'the tool wrote no retrieval status, so it never reached a terminal path. The probe cannot ' +
        'tell a served result from an empty one without it - check the ToolContext wiring.',
    };
  }
  if (status.kind === 'failed') {
    return {
      kind: 'unmeasurable',
      reason: `retrieval reported outcome "${status.outcome}" rather than running to completion, so no configuration was exercised.`,
    };
  }

  // Decided before the event is inspected, because the keyword fallback that runs after a
  // floor-emptied semantic arm writes an unscored audit row of its own. Reading THAT as
  // `keyword-fallback` is what made every nonzero floor abort the sweep on its first negative
  // question - the exact rows the floor was added to produce.
  if (status.kind === 'floor-emptied') return { kind: 'nothing' };

  if (!event) {
    // Absence is only trustworthy when the tool itself says it had nothing to serve.
    if (status.kind === 'served-content') {
      return {
        kind: 'unmeasurable',
        reason:
          'retrieval served content but no lake-audit event arrived within the wait window. Either ' +
          'the un-awaited audit write stalled, or nothing served was attributable to a lake (the ' +
          "preflight's own-files precondition exists to rule the latter out).",
      };
    }
    return { kind: 'nothing' };
  }

  if (!event.scores || event.scores.length === 0) return { kind: 'keyword-fallback' };
  const fileIds = event.fileIds ?? [];
  // A scored event with no files should not occur (scores are index-aligned to the ranked chunks
  // those files came from). It is not the keyword arm either - that arm writes no scores - so
  // diagnosing it as one would send the operator after an embedding credential that is fine.
  if (fileIds.length === 0) {
    return {
      kind: 'unmeasurable',
      reason: 'the audit event carried per-chunk scores but no file ids, which the semantic arm cannot produce.',
    };
  }
  return { kind: 'served', fileIds };
}
