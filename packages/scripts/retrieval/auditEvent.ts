/**
 * Reading one lake-audit event as "what did retrieval actually serve".
 *
 * Pure and separated from the live driver because this is the single decision the whole measurement
 * rests on: the same absent-event condition means "correctly served nothing" in one case and "the
 * probe cannot see what was served" in another, and getting that backwards silently reports a
 * healthy configuration as a total recall failure. It needs to be testable without a stage.
 */

/** The fields of a captured `RecordLakeAccessEventInput` this reading depends on. */
export type AuditEventShape = {
  fileIds?: string[];
  scores?: number[];
};

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
  /** Retrieval reported a non-ok outcome (`failed`, `no_lakes`). */
  | { kind: 'failed'; outcome: string }
  /** No retrieval status was written at all, so the tool did not reach a terminal path. */
  | { kind: 'absent' };

/** The `promptMeta` fields this reading depends on. The tool writes more; none of the rest matters. */
export type CapturedPromptMeta = {
  citables?: unknown[];
  retrieval?: { outcome?: string };
};

/**
 * Collapse the status writes captured across one tool call into the one fact the audit reading
 * needs.
 *
 * The last write carrying `retrieval` is the terminal one: a semantic arm that finds nothing falls
 * through to the keyword arm, which writes its own. `citables` is checked across every write
 * because it is the tool's record of what actually reached the model, and the keyword arm's no-hit
 * branch is the one path that omits it.
 */
export function readRetrievalStatus(metas: readonly CapturedPromptMeta[]): RetrievalStatus {
  const terminal = [...metas].reverse().find(m => m.retrieval)?.retrieval;
  if (!terminal) return { kind: 'absent' };
  const outcome = terminal.outcome ?? 'unknown';
  if (outcome !== 'ok') return { kind: 'failed', outcome };
  return metas.some(m => (m.citables?.length ?? 0) > 0) ? { kind: 'served-content' } : { kind: 'no-content' };
}

export type ServedReading =
  /** Retrieval ran and served these files. */
  | { kind: 'served'; fileIds: string[] }
  /** Retrieval ran and served nothing. On a negative question this is the desired outcome. */
  | { kind: 'nothing' }
  /**
   * The semantic arm did not run and the keyword fallback answered instead. Neither knob under test
   * applies there, so the configuration was never exercised and the run must stop rather than
   * report a keyword-search number as a budget-sweep row.
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
