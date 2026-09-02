/**
 * Cross-document inconsistency detection for a curated corpus (#2242).
 *
 * A lake can hold documents that flatly contradict each other while every retrievability predicate
 * passes. That content is what produces a confident wrong answer when retrieval works perfectly, so
 * noticing it is a health signal in its own right.
 *
 * DETECTION ONLY. Nothing here rejects, gates or admits anything. Deciding that ingestion should
 * refuse a document for disagreeing with a sibling would make this product the arbiter of a
 * customer's editorial judgment - a product position to take deliberately, if at all, and never to
 * arrive at by implementation. A follow-up that turns any of this into a gate has to be argued on
 * its own merits.
 *
 * Pure and LLM-free by design: every rule below is a pattern over text, so a finding can be shown to
 * a human with the exact sentence that produced it. That is also the honest limit - these are
 * recall-oriented heuristics over prose, so a finding means "worth a human's eye", never "proven
 * contradiction". Callers must present them that way.
 */

/**
 * The classes this detector recognises. Each is a distinct rule with its own evidence shape, and
 * they are deliberately narrow: a rule that fires on ambiguous prose costs a reader more than it
 * saves, because every false finding is a document they re-read for nothing.
 */
export const INCONSISTENCY_KINDS = [
  /** Two documents each claim exclusivity over the same category ("the only X", "the fastest X"). */
  'superlative-conflict',
  /** One number stated two ways for the same labelled metric across documents. */
  'metric-disagreement',
  /** The same organization labelled a customer in one document and a prospect in another. */
  'relationship-conflict',
  /** Dated claims that have silently become false, grouped by the year they expired in. */
  'expired-claim',
] as const;

/**
 * NOT IMPLEMENTED, and named here so its absence is visible rather than inferred: #2242 lists a
 * fifth class - availability versus marketing, where one document calls a capability current and
 * shipping while another describes it as in development with GA expected in a future year.
 *
 * `expired-claim` does not cover it. That rule only fires once a year has already PASSED, and this
 * case is a present-tense contradiction between two documents with no expired year involved. It
 * needs a rule that pairs a shipping-now assertion against a future-GA assertion on the same
 * subject, which is a different shape from all four above.
 *
 * Left unbuilt deliberately: the four here are the ones whose precision could be argued from real
 * prose. This is why the PR carrying this module does not close #2242.
 */
export const UNIMPLEMENTED_INCONSISTENCY_CLASS = 'availability-vs-marketing' as const;
export type InconsistencyKind = (typeof INCONSISTENCY_KINDS)[number];

export interface CorpusDocument {
  fabFileId: string;
  fileName?: string | null;
  /** Extracted text. Any assembly of it is fine; the rules are line- and sentence-oriented. */
  text: string;
}

export interface InconsistencyEvidence {
  fabFileId: string;
  fileName: string | null;
  /** The sentence that matched, trimmed and bounded, so a reader can judge the finding itself. */
  excerpt: string;
}

export interface InconsistencyFinding {
  kind: InconsistencyKind;
  /**
   * What the documents disagree ABOUT - a category, a metric label, an organization name. Normalized
   * for grouping, so it is a key rather than prose.
   */
  subject: string;
  /**
   * Bounded at `EVIDENCE_MAX` entries, one per document. Read `documentCount` for how many documents
   * the finding actually spans - a finding capped here still reports its true reach.
   */
  evidence: InconsistencyEvidence[];
  /**
   * Documents this finding spans, before `EVIDENCE_MAX`. Always at least 2 for the cross-document
   * kinds; 1 or more for `expired-claim`, which groups by year across the corpus.
   */
  documentCount: number;
}

/** Longest excerpt carried per finding. Enough to judge a claim, short enough to render in a list. */
const EXCERPT_MAX = 240;

/**
 * Documents quoted per finding.
 *
 * A count cap on findings is not a byte cap without this. Evidence carries one entry per distinct
 * document, each up to `EXCERPT_MAX`, so a subject shared across a large sample puts that many
 * excerpts in a SINGLE finding - measured at ~11.8 MB for one report, against MongoDB's 16 MB
 * document ceiling, on a corpus of per-period reports repeating the same labelled metrics. The
 * report is stored on the lake document, so the ceiling is a real failure mode rather than a
 * theoretical one, and `documentCount` keeps the truncation from costing the reader the number.
 */
const EVIDENCE_MAX = 20;

/**
 * Sentence-ish split. Deliberately crude: a full NLP splitter buys nothing here, because every rule
 * only needs a bounded window of words around a match to quote back to a reader.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function excerpt(sentence: string): string {
  return sentence.length <= EXCERPT_MAX ? sentence : `${sentence.slice(0, EXCERPT_MAX - 3)}...`;
}

/** Grouping key: case-folded, punctuation-stripped, whitespace-collapsed. */
function normalizeSubject(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s%.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Superlatives that assert EXCLUSIVITY. "better" and "faster" are absent on purpose: a comparative
 * is a relative claim and two documents can both hold one without contradicting each other.
 */
const SUPERLATIVE = /\b(only|sole|first|fastest|largest|highest|best|leading|number one|no\.?\s*1|#1)\b/i;
/**
 * The category the superlative is claimed over: the TWO words after it, at most.
 *
 * Bounded tightly on purpose. A greedy noun phrase swallows trailing context - "the fastest ingest
 * pipeline on the market" and "the fastest ingest pipeline available anywhere" are the same claim,
 * and a wider window keys them differently and finds nothing. Two words is the shortest span that
 * still distinguishes "ingest pipeline" from "query planner"; the cross-document requirement is what
 * keeps the looseness from producing noise.
 */
const SUPERLATIVE_SUBJECT =
  /\b(?:only|sole|first|fastest|largest|highest|best|leading)\s+([a-z0-9-]+(?:\s+[a-z0-9-]+)?)/i;

/** `Label: 42%` / `Label is 42 percent` / `Label was 1,200 ms`. */
const METRIC =
  /([A-Za-z][A-Za-z0-9 _/-]{2,40}?)\s*(?::|\bis\b|\bwas\b|\bof\b)\s*([0-9][0-9,.]*)\s*(%|percent|ms|s|gb|mb|tb|x)?\b/i;

const CUSTOMER = /\b(customer|client|deployed|in production with|live with)\b/i;
const PROSPECT = /\b(prospect|pipeline|opportunity|evaluating|pilot|proof of concept|poc|trialling|trialing)\b/i;
/**
 * Capitalized MULTI-WORD name, the cheapest organization proxy that does not need a gazetteer.
 *
 * At least two capitalized tokens, which is what the description always claimed and what the trailing
 * quantifier did not enforce. With `{0,3}` a single capitalized token was a complete "organization",
 * so a sentence-initial `The` became a subject - and since CUSTOMER/PROSPECT carry generic technical
 * vocabulary (`deployed`, `pipeline`, `pilot`), two entirely unrelated sentences produced a
 * relationship-conflict on the subject `"the"`. It then sorted to the front of its kind and outranked
 * real organization conflicts.
 *
 * The cost is single-word company names, which this rule now cannot see. That is the right side to
 * err on: a missed finding costs a reader nothing, and a finding about `"the"` costs them the
 * credibility of every other finding in the list.
 *
 * Used only with `matchAll`, which clones the regex - so the module-level `/g` cannot leak `lastIndex`
 * between calls. Adding an `ORG.test(...)` anywhere would silently break that.
 */
const ORG = /\b([A-Z][A-Za-z0-9&.-]+(?:\s+[A-Z][A-Za-z0-9&.-]+){1,3})\b/g;

/**
 * A FORWARD-LOOKING dated claim: `supported through 2024`, `expected in 2024`, `GA in 2024`.
 *
 * The bare `through|until` form this used to accept does not distinguish a commitment from a
 * retrospective statement of fact. `Revenue grew through 2024.` is permanently true and was reported
 * as expired, as were `Data was collected through 2019.` and any changelog line. Historical
 * narrative is among the most common shapes in a curated corpus, so that imprecision was not a
 * rounding error - it was most of what this rule emitted.
 *
 * `through|until|thru` therefore now requires a lead-in that makes the claim a commitment about the
 * future. The cost is recall on phrasings not in the list; the alternative was a rule whose findings
 * a reader learns to skip.
 */
const DATED_CLAIM =
  /\b(?:(?:supported|available|valid|effective|maintained|offered|guaranteed|current)\s+(?:through|until|thru)|expected\s+(?:in|by)|available\s+(?:in|by)|ga\s+in)\s+((?:19|20)\d{2})\b/i;

type Hit = { doc: CorpusDocument; sentence: string; subject: string; detail?: string };

function collect(
  documents: CorpusDocument[],
  extract: (sentence: string) => { subject: string; detail?: string } | null
): Hit[] {
  const hits: Hit[] = [];
  for (const doc of documents) {
    for (const sentence of sentences(doc.text)) {
      const found = extract(sentence);
      if (found) hits.push({ doc, sentence, subject: found.subject, detail: found.detail });
    }
  }
  return hits;
}

function toEvidence(hit: Hit): InconsistencyEvidence {
  return { fabFileId: hit.doc.fabFileId, fileName: hit.doc.fileName ?? null, excerpt: excerpt(hit.sentence) };
}

/**
 * Group hits by subject and keep only groups spanning MORE THAN ONE document.
 *
 * The cross-document requirement is the whole point: one document restating its own superlative in
 * three sections is not an inconsistency, and flagging it would bury the real findings. `distinguish`
 * additionally requires the grouped hits to actually DISAGREE - two documents stating the same metric
 * at the same value agree, and agreement is not a finding.
 */
function crossDocumentGroups(
  hits: Hit[],
  kind: InconsistencyKind,
  distinguish?: (hits: Hit[]) => boolean
): InconsistencyFinding[] {
  const bySubject = new Map<string, Hit[]>();
  for (const hit of hits) {
    const existing = bySubject.get(hit.subject);
    if (existing) existing.push(hit);
    else bySubject.set(hit.subject, [hit]);
  }

  const findings: InconsistencyFinding[] = [];
  for (const [subject, group] of bySubject) {
    const docIds = new Set(group.map(h => h.doc.fabFileId));
    if (docIds.size < 2) continue;
    if (distinguish && !distinguish(group)) continue;
    // One excerpt per document: three sentences from the same file are one document's position.
    const seen = new Set<string>();
    const perDocument = group.filter(h => !seen.has(h.doc.fabFileId) && (seen.add(h.doc.fabFileId), true));
    findings.push({
      kind,
      subject,
      evidence: perDocument.slice(0, EVIDENCE_MAX).map(toEvidence),
      documentCount: perDocument.length,
    });
  }
  return findings;
}

function detectSuperlativeConflicts(documents: CorpusDocument[]): InconsistencyFinding[] {
  return crossDocumentGroups(
    collect(documents, sentence => {
      if (!SUPERLATIVE.test(sentence)) return null;
      const subject = SUPERLATIVE_SUBJECT.exec(sentence)?.[1];
      return subject ? { subject: normalizeSubject(subject) } : null;
    }),
    'superlative-conflict'
  );
}

function detectMetricDisagreements(documents: CorpusDocument[]): InconsistencyFinding[] {
  return crossDocumentGroups(
    collect(documents, sentence => {
      const match = METRIC.exec(sentence);
      if (!match) return null;
      const [, label, value, unit] = match;
      return { subject: normalizeSubject(label), detail: `${value.replace(/,/g, '')}${unit?.toLowerCase() ?? ''}` };
    }),
    'metric-disagreement',
    // Agreement is not a finding: two documents quoting the same figure are consistent.
    group => new Set(group.map(h => h.detail)).size > 1
  );
}

function detectRelationshipConflicts(documents: CorpusDocument[]): InconsistencyFinding[] {
  const hits: Hit[] = [];
  for (const doc of documents) {
    for (const sentence of sentences(doc.text)) {
      const isCustomer = CUSTOMER.test(sentence);
      const isProspect = PROSPECT.test(sentence);
      // A sentence carrying BOTH labels is describing the transition ("a prospect that became a
      // customer"), which is not a contradiction. Skipping it is what keeps this rule usable.
      if (isCustomer === isProspect) continue;
      for (const [, org] of sentence.matchAll(ORG)) {
        hits.push({ doc, sentence, subject: normalizeSubject(org), detail: isCustomer ? 'customer' : 'prospect' });
      }
    }
  }
  return crossDocumentGroups(hits, 'relationship-conflict', group => new Set(group.map(h => h.detail)).size > 1);
}

/**
 * Dated claims whose year has passed, grouped BY YEAR across the corpus. The corpus contradicts the
 * calendar rather than a sibling - the only rule here that does not need two documents to disagree.
 *
 * Grouped rather than one finding per matching sentence, which is what it used to be and what made
 * it the report's volume driver: a single boilerplate footer repeated across a sampled corpus
 * produced one finding per member, and because findings sort by kind name with `expired-claim`
 * first, those alone filled the stored cap and evicted every genuine cross-document finding the
 * feature exists to produce. Measured at 220 findings in, 200 stored, all 20 cross-document ones
 * discarded. Grouping collapses that to one finding per year.
 *
 * The meaning shifts with the shape, and the new one is the more useful of the two: "N documents
 * carry claims that expired in 2024", with the documents listed, rather than N separate reports of
 * the same fact. Same evidence bound as the cross-document rules, and `documentCount` carries the
 * reach the bound truncates.
 */
function detectExpiredClaims(documents: CorpusDocument[], nowYear: number): InconsistencyFinding[] {
  const byYear = new Map<string, Hit[]>();
  for (const doc of documents) {
    for (const sentence of sentences(doc.text)) {
      const year = Number(DATED_CLAIM.exec(sentence)?.[1]);
      if (!Number.isFinite(year) || year >= nowYear) continue;
      const subject = String(year);
      const existing = byYear.get(subject);
      if (existing) existing.push({ doc, sentence, subject });
      else byYear.set(subject, [{ doc, sentence, subject }]);
    }
  }

  const findings: InconsistencyFinding[] = [];
  for (const [subject, hits] of byYear) {
    // One excerpt per document, as everywhere else: a document restating its own expiring claim in
    // three sections holds one position, not three.
    const seen = new Set<string>();
    const perDocument = hits.filter(h => !seen.has(h.doc.fabFileId) && (seen.add(h.doc.fabFileId), true));
    findings.push({
      kind: 'expired-claim',
      subject,
      evidence: perDocument.slice(0, EVIDENCE_MAX).map(toEvidence),
      documentCount: perDocument.length,
    });
  }
  return findings;
}

export interface CorpusInconsistencyReport {
  /**
   * Bounded by `maxFindings`, allocated per kind - see `capPerKind`. Read `countsByKind` for the
   * exact totals and `truncated` for whether anything was dropped.
   */
  findings: InconsistencyFinding[];
  /** Exact, always over ALL findings - never affected by `maxFindings`. */
  countsByKind: Record<InconsistencyKind, number>;
  /**
   * True when the pass did not read every chunk of every member, so counts are a LOWER BOUND.
   *
   * Today this is unconditionally true for any lake pass: the caller reads a bounded number of
   * chunks from the start of each member, so no run has ever examined a corpus whole. It was
   * previously derived from member overflow alone, which meant a lake under the member cap reported
   * `sampled: false` - "counts are not a lower bound" - about a pass that had read five chunks per
   * document. An owner seeing `{findingCount: 0, sampled: false}` reasonably concluded the corpus
   * was read and is clean.
   */
  sampled: boolean;
  /** True when `maxFindings` dropped findings. `sampled` cannot serve this - it is about members. */
  truncated: boolean;
}

/**
 * A corpus report plus what the LAKE pass knows that the pure detector cannot: how many members it
 * actually read, and whether the lake outgrew the member cap.
 *
 * Stored on the lake document and rendered by `computeLakeHealth`, so it is the shape a surface sees.
 */
export interface LakeInconsistencyReport extends CorpusInconsistencyReport {
  /** True when the lake has more members than the pass sampled - the actionable half of `sampled`. */
  memberSampled: boolean;
  /**
   * Members whose text was actually read. Zero means nothing was scanned, which a reader must be able
   * to tell apart from "scanned and clean" - see the null-tag guard in `detectLakeInconsistencies`.
   */
  memberCount: number;
}

/**
 * Run every rule over a corpus.
 *
 * `nowYear` is injected rather than read from the clock so a report is reproducible - a test, and a
 * plan an owner already looked at, both need the same input to give the same answer.
 */
export function detectCorpusInconsistencies(
  documents: CorpusDocument[],
  options: { nowYear: number; sampled?: boolean; maxFindings?: number }
): CorpusInconsistencyReport {
  const findings = [
    ...detectSuperlativeConflicts(documents),
    ...detectMetricDisagreements(documents),
    ...detectRelationshipConflicts(documents),
    ...detectExpiredClaims(documents, options.nowYear),
  ];

  const countsByKind: Record<InconsistencyKind, number> = {
    'superlative-conflict': 0,
    'metric-disagreement': 0,
    'relationship-conflict': 0,
    'expired-claim': 0,
  };
  for (const finding of findings) countsByKind[finding.kind] += 1;

  // Stable order so two runs over unchanged content produce an identical report.
  findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject));

  const kept = options.maxFindings === undefined ? findings : capPerKind(findings, options.maxFindings);

  return {
    findings: kept,
    countsByKind,
    sampled: options.sampled ?? false,
    truncated: kept.length < findings.length,
  };
}

/**
 * Take up to `max` findings without letting one kind starve the others.
 *
 * A plain `slice` could not do this: findings sort by kind NAME, so `expired-claim` sits at the front
 * of every report and `superlative-conflict` is evicted first. Any kind that out-produces the others
 * therefore took the whole budget, and the kinds it displaced were the cross-document ones - the
 * thing the feature exists to find. Grouping `expired-claim` by year removed today's instance of
 * that; allocating the cap removes the shape of the bug, so the next rule that emits in volume
 * cannot re-create it.
 *
 * Round-robin by position across the kinds present. A kind that runs out simply stops contributing
 * while the others keep drawing, so a report holding only one kind still fills the cap and no budget
 * is left unspent. The emitted list is re-derived from the sorted input, so it keeps the report's
 * declared ordering rather than the interleaved order it was selected in.
 */
function capPerKind(findings: InconsistencyFinding[], max: number): InconsistencyFinding[] {
  if (findings.length <= max) return findings;

  const queues = new Map<InconsistencyKind, InconsistencyFinding[]>();
  for (const finding of findings) {
    const existing = queues.get(finding.kind);
    if (existing) existing.push(finding);
    else queues.set(finding.kind, [finding]);
  }

  const taken = new Set<InconsistencyFinding>();
  const lanes = [...queues.values()];
  let cursor = 0;
  while (taken.size < max) {
    let progressed = false;
    for (const lane of lanes) {
      if (taken.size >= max) break;
      const next = lane[cursor];
      if (!next) continue;
      taken.add(next);
      progressed = true;
    }
    // Every lane is exhausted before the budget is: nothing left to allocate.
    if (!progressed) break;
    cursor += 1;
  }

  // Re-derive from the sorted input rather than from the round-robin order, so the emitted list keeps
  // the report's declared ordering instead of interleaving kinds.
  return findings.filter(f => taken.has(f));
}
