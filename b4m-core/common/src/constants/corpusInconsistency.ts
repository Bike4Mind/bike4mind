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
  /** A dated claim that has silently become false. Single-document, unlike the three above. */
  'expired-claim',
] as const;
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
  /** Always at least 2 for the cross-document kinds; exactly 1 for `expired-claim`. */
  evidence: InconsistencyEvidence[];
}

/** Longest excerpt carried per finding. Enough to judge a claim, short enough to render in a list. */
const EXCERPT_MAX = 240;

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
/** Capitalized multi-word name, the cheapest organization proxy that does not need a gazetteer. */
const ORG = /\b([A-Z][A-Za-z0-9&.-]+(?:\s+[A-Z][A-Za-z0-9&.-]+){0,3})\b/g;

/** `through 2024`, `until 2024`, `expected in 2024`, `GA in 2024`. */
const DATED_CLAIM = /\b(?:through|until|thru|expected\s+(?:in|by)|available\s+(?:in|by)|ga\s+in)\s+((?:19|20)\d{2})\b/i;

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
    const evidence = group.filter(h => !seen.has(h.doc.fabFileId) && (seen.add(h.doc.fabFileId), true)).map(toEvidence);
    findings.push({ kind, subject, evidence });
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
 * A dated claim whose year has passed. Single-document, unlike the three cross-document rules: the
 * document contradicts the calendar rather than a sibling. Listed with them because it produces the
 * same failure - retrieval serves a claim that is no longer true, confidently.
 */
function detectExpiredClaims(documents: CorpusDocument[], nowYear: number): InconsistencyFinding[] {
  const findings: InconsistencyFinding[] = [];
  for (const doc of documents) {
    for (const sentence of sentences(doc.text)) {
      const year = Number(DATED_CLAIM.exec(sentence)?.[1]);
      if (!Number.isFinite(year) || year >= nowYear) continue;
      findings.push({
        kind: 'expired-claim',
        subject: String(year),
        evidence: [toEvidence({ doc, sentence, subject: String(year) })],
      });
    }
  }
  return findings;
}

export interface CorpusInconsistencyReport {
  findings: InconsistencyFinding[];
  countsByKind: Record<InconsistencyKind, number>;
  /** True when the caller sampled rather than read the whole corpus, so counts are a lower bound. */
  sampled: boolean;
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

  return {
    findings: options.maxFindings === undefined ? findings : findings.slice(0, options.maxFindings),
    countsByKind,
    sampled: options.sampled ?? false,
  };
}
