import { detectCorpusInconsistencies, type CorpusDocument, type InconsistencyKind } from '@bike4mind/common';

/**
 * Retrieval-time cross-document conflict note.
 *
 * When a single retrieval call pools passages from several documents, two of them can flatly
 * disagree - the same metric at two values, two documents each claiming "the only X" - and the model
 * sees both claims with equal authority and no signal that they conflict. It picks one, usually the
 * highest-ranked, and answers confidently.
 *
 * This runs the existing corpus detector over the handful of passages a call already holds in memory
 * (no DB read, no LLM call) and turns a non-empty result into a note the caller concatenates at
 * column 0, OUTSIDE the untrusted content block. Sibling of renderRetrievedContentBlock.ts: shared by
 * all three retrieval channels so the wording and the leak-safety decision cannot drift apart.
 *
 * Distinct surface from detectLakeInconsistencies.ts, which shares the same rule engine but is an
 * async, stored, admin-facing whole-lake health scan. Do not route one through the other.
 */

/** One passage as a retrieval channel already holds it: the id it will attribute, the text it will render. */
export interface RetrievalPassage {
  fabFileId: string;
  text: string;
}

/**
 * The kinds that mean two documents DISAGREE. `expired-claim` is excluded on purpose: it fires on a
 * single document against the calendar, which is a staleness signal rather than a disagreement, and
 * it is the rule whose volume drove the detector's per-kind cap allocation.
 *
 * Order is the render order of the count terms, so it is fixed rather than incidental.
 */
export const RETRIEVAL_CONFLICT_KINDS: readonly InconsistencyKind[] = [
  'superlative-conflict',
  'metric-disagreement',
  'relationship-conflict',
];

/** Documents named before the list degrades to "and N more". Keeps the note a bounded length. */
export const RETRIEVAL_CONFLICT_MAX_IDS = 10;

/**
 * Defensive ceiling on text swept per call. Every site today is bounded well under this by its own
 * char budget, so this never fires - it exists so a future budget increase cannot put an unbounded
 * regex sweep on the hot chat path.
 */
export const RETRIEVAL_CONFLICT_MAX_CHARS = 120_000;

/** Marker the site tests slice on, and the prefix `defangRetrievedContent` already indents inside content. */
const NOTE_OPENING = 'NOTE: the retrieved documents below disagree with each other.';

/**
 * A column-0 note when the passages of ONE retrieval call disagree across documents, or '' when they
 * do not. The caller concatenates it alongside its other notes, outside the untrusted content block.
 *
 * Renders `fabFileId`, counts, and our own `kind` vocabulary only. `subject`, `excerpt` and `fileName`
 * are all derived from document prose - a crafted one could carry a forged marker into our own
 * framing - so none of them may ever appear here. `fabFileId` is MongoDB-generated and already
 * interpolated raw into passage headings today, so it needs no `toContentLabel`.
 *
 * `nowYear` is a parameter for the same reason the detector takes one: reproducibility under test.
 */
export function buildRetrievalConflictNote(
  passages: RetrievalPassage[],
  nowYear: number = new Date().getUTCFullYear()
): string {
  // The common case on the hot path: one document cannot disagree with itself across documents, so
  // return before paying for the regex sweep.
  if (new Set(passages.map(p => p.fabFileId)).size < 2) return '';

  // One CorpusDocument per document, in first-appearance order. `fileName` is deliberately not
  // carried: it is never rendered, so there is nothing for it to leak out of.
  const byFile = new Map<string, string[]>();
  for (const passage of passages) {
    const existing = byFile.get(passage.fabFileId);
    if (existing) existing.push(passage.text);
    else byFile.set(passage.fabFileId, [passage.text]);
  }

  const documents: CorpusDocument[] = [];
  let chars = 0;
  for (const [fabFileId, texts] of byFile) {
    const text = texts.join('\n\n');
    const remaining = RETRIEVAL_CONFLICT_MAX_CHARS - chars;
    if (remaining <= 0) break;
    documents.push({ fabFileId, text: text.length > remaining ? text.slice(0, remaining) : text });
    chars += Math.min(text.length, remaining);
  }

  const { findings } = detectCorpusInconsistencies(documents, { nowYear });
  // `documentCount >= 2` is already guaranteed by the cross-document rules; asserted again here so a
  // future rule joining RETRIEVAL_CONFLICT_KINDS cannot emit a single-document "disagreement".
  const kept = findings.filter(f => RETRIEVAL_CONFLICT_KINDS.includes(f.kind) && f.documentCount >= 2);
  if (kept.length === 0) return '';

  const kindTerms = RETRIEVAL_CONFLICT_KINDS.map(kind => ({
    kind,
    count: kept.filter(f => f.kind === kind).length,
  }))
    .filter(t => t.count > 0)
    .map(t => `${t.kind}: ${t.count}`)
    .join(', ');

  const ids = [...new Set(kept.flatMap(f => f.evidence.map(e => e.fabFileId)))];
  const overflow = ids.length - RETRIEVAL_CONFLICT_MAX_IDS;
  const idList =
    overflow > 0 ? `${ids.slice(0, RETRIEVAL_CONFLICT_MAX_IDS).join(', ')}, and ${overflow} more` : ids.join(', ');

  return (
    `${NOTE_OPENING} ${kept.length} cross-document conflict(s) detected (${kindTerms}) across documents ` +
    `${idList}. These are heuristic pattern matches over the passage text, not proven contradictions. ` +
    'Do not silently pick one side: tell the user the sources disagree, attribute each conflicting claim ' +
    'to the document it came from, and say which one you relied on and why.\n\n'
  );
}
