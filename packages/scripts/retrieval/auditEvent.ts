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
  | { kind: 'keyword-fallback' };

/**
 * `search_knowledge_base` records an audit event from two places (`knowledgeBaseSearch/index.ts`,
 * the semantic arm at ~974 and the keyword arm at ~1224). They are told apart by their PAYLOAD, not
 * their `surface`, which is identical on both:
 *
 * - semantic arm: carries `chunkIds` and per-chunk `scores`.
 * - keyword arm:  carries `fileIds` only, no scores (it is metadata-only, with no chunk ranking).
 *
 * No event at all means no lake read was recorded, which for a caller who owns no files of their own
 * means the search produced no output. The probe enforces that "owns no files" precondition in its
 * preflight, because without it an unattributable personal-file hit also produces no event and would
 * be misread here as "served nothing".
 */
export function readServedDocuments(event: AuditEventShape | null | undefined): ServedReading {
  if (!event) return { kind: 'nothing' };
  if (!event.scores || event.scores.length === 0) return { kind: 'keyword-fallback' };
  const fileIds = event.fileIds ?? [];
  // A scored event with no files should not occur (scores are index-aligned to the ranked chunks
  // those files came from), but reading it as 'served' with an empty list would silently score a
  // zero-recall question as if retrieval had legitimately returned nothing.
  if (fileIds.length === 0) return { kind: 'keyword-fallback' };
  return { kind: 'served', fileIds };
}
