/**
 * Deterministic grader for the lake-RAG bank. Pure: no model, no lake, no DB - the live driver
 * fetches the reply and the turn's `promptMeta.citables` and hands them here.
 *
 * Three checks, all of which must pass:
 * - answer: every `expect` pattern appears (or, for `absent`, the reply names the gap);
 * - stale rejection: no `rejectTokens` value is asserted as current;
 * - citation: the reply cites `expectSource`.
 *
 * Lexical by design, like the sibling evals: it will miss an exotic paraphrase, but it will not
 * pass a reply that states the stale value as the answer.
 */
import type { CitableSource } from '@bike4mind/common';
import type { EvalGrade } from '../harness';
import type { LakeRagBankRow, LakeRagKind } from './bank';
import { LAKE_RAG_KINDS } from './bank';

/**
 * Matches a bank pattern as a whole token, so `82` does not match `182`, `1982` or `8.82`, and
 * `8,848` does not match inside `8,848.86`.
 */
export function tokenMatcher(source: string): RegExp {
  return new RegExp(`(?<![\\w]|\\d[.,])(?:${source})(?![\\w]|[.,]\\d)`, 'i');
}

/**
 * Splits on sentence ends, but not on a decimal point: `sentences` in `../harness` splits
 * `331.4 million` in two, which would hide a stale figure from the per-sentence scope below. A
 * newline also ends a sentence, so one bullet cannot excuse another.
 */
function numericSafeSentences(reply: string): string[] {
  return reply.split(/[!?;\n]+|\.(?!\d)/).filter(s => s.trim().length > 0);
}

/**
 * Marks a value as historical rather than current. A reply that says "146, up from an earlier
 * count of 82" has rejected the stale value, not asserted it, so the marker excuses its own
 * sentence only.
 */
const STALE_CONTEXT =
  /\b(?:earlier|previous(?:ly)?|older|outdated|out\s+of\s+date|superseded|formerly|originally|prior|no\s+longer|used\s+to|stale|obsolete|replaced|until|before|up\s+from|down\s+from)\b/i;

const NEGATION = `(?:could|can|did|do|does|is|are|was|were)(?:n['\\u2019]?t|['\\u2019]t|\\s*not)`;

/** "The lake does not have this" in the phrasings a model reaches for. */
const ABSENCE: RegExp[] = [
  new RegExp(
    `\\b${NEGATION}\\s+(?:seem\\s+to\\s+)?(?:contain|include|mention|cover|have|say|state|specify|provide|find|locate|list|give|appear)\\b`,
    'i'
  ),
  /(?:\bnot|n['\u2019]t)\s+(?:mentioned|covered|included|specified|stated|provided|available|found|listed|given)\b/i,
  /\b(?:unable|not\s+able)\s+to\s+(?:find|locate|determine)\b/i,
  /\bno\s+(?:information|mention|data|details?|record|figure|reference)\b/i,
  /\bnothing\s+(?:in|about|on)\b/i,
];

export type LakeRagCitationContext =
  | {
      citationStyle: 'indexed';
      /** The turn's `promptMeta.citables`, in order: `[N]` resolves to `citables[N-1]`. */
      citables: readonly Pick<CitableSource, 'title'>[];
    }
  | { citationStyle: 'named' };

export type CitationCheck =
  | { status: 'not-applicable' }
  | { status: 'matched' }
  | { status: 'missing' }
  | { status: 'wrong-source'; cited: string[] }
  | { status: 'dangling'; markers: number[] };

export type LakeRagGrade = EvalGrade & {
  kind: LakeRagKind;
  answer: boolean;
  staleRejected: boolean;
  citation: CitationCheck;
};

function gradeAnswer(row: LakeRagBankRow, reply: string): boolean {
  if (row.kind === 'absent') return ABSENCE.some(pattern => pattern.test(reply));
  return row.expect.every(source => tokenMatcher(source).test(reply));
}

/** The stale tokens the reply asserts as current - each one found in a sentence with no stale marker. */
function assertedStaleTokens(row: LakeRagBankRow, reply: string): string[] {
  const unmarked = numericSafeSentences(reply).filter(sentence => !STALE_CONTEXT.test(sentence));
  return row.rejectTokens.filter(source => {
    const matcher = tokenMatcher(source);
    return unmarked.some(sentence => matcher.test(sentence));
  });
}

function citedIndices(reply: string): number[] {
  const markers = [...reply.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)];
  return [...new Set(markers.flatMap(m => m[1].split(',').map(n => Number(n.trim()))))];
}

function gradeIndexedCitation(
  expectSource: string,
  reply: string,
  citables: readonly Pick<CitableSource, 'title'>[]
): CitationCheck {
  const indices = citedIndices(reply);
  if (indices.length === 0) return { status: 'missing' };
  // An out-of-range marker is a broken citation contract, not just a miss: the UI renders it as a
  // chip pointing at nothing (or, if the prefix invariant broke, at the wrong document).
  const dangling = indices.filter(n => n < 1 || n > citables.length);
  if (dangling.length > 0) return { status: 'dangling', markers: dangling };
  const cited = indices.map(n => citables[n - 1].title);
  return cited.some(title => title.toLowerCase() === expectSource.toLowerCase())
    ? { status: 'matched' }
    : { status: 'wrong-source', cited };
}

/** `galilean-moons.md` matches "galilean-moons.md", "galilean-moons" or "Galilean Moons". */
function gradeNamedCitation(expectSource: string, reply: string): CitationCheck {
  const words = expectSource
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[\s_-]+/)
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const named = new RegExp(`\\b${words.join('[\\s_-]+')}\\b`, 'i');
  return named.test(reply) ? { status: 'matched' } : { status: 'missing' };
}

function gradeCitation(row: LakeRagBankRow, reply: string, context: LakeRagCitationContext): CitationCheck {
  if (row.expectSource === null) return { status: 'not-applicable' };
  return context.citationStyle === 'indexed'
    ? gradeIndexedCitation(row.expectSource, reply, context.citables)
    : gradeNamedCitation(row.expectSource, reply);
}

function describeCitationFailure(check: CitationCheck, expectSource: string | null): string {
  switch (check.status) {
    case 'missing':
      return `did not cite ${expectSource}`;
    case 'wrong-source':
      return `cited ${check.cited.join(', ')} instead of ${expectSource}`;
    case 'dangling':
      return `citation marker(s) out of range: ${check.markers.map(n => `[${n}]`).join(', ')}`;
    default:
      return '';
  }
}

export function gradeLakeRag(row: LakeRagBankRow, reply: string, context: LakeRagCitationContext): LakeRagGrade {
  const answer = gradeAnswer(row, reply);
  const staleAsserted = assertedStaleTokens(row, reply);
  const citation = gradeCitation(row, reply, context);
  const citationOk = citation.status === 'matched' || citation.status === 'not-applicable';

  const failures = [
    ...(answer
      ? []
      : [row.kind === 'absent' ? 'answered without saying the lake lacks it' : 'expected answer missing']),
    ...(staleAsserted.length === 0 ? [] : [`asserted stale value: ${staleAsserted.join(', ')}`]),
    ...(citationOk ? [] : [describeCitationFailure(citation, row.expectSource)]),
  ];
  return {
    passed: failures.length === 0,
    reason: failures.length === 0 ? 'answered from the current source' : failures.join('; '),
    kind: row.kind,
    answer,
    staleRejected: staleAsserted.length === 0,
    citation,
  };
}

/** The grade to record when the live driver gets no reply text. Fails every check. */
export function gradeLakeRagEmpty(row: LakeRagBankRow, reason: string): LakeRagGrade {
  return {
    passed: false,
    reason,
    kind: row.kind,
    answer: false,
    staleRejected: false,
    citation: row.expectSource === null ? { status: 'not-applicable' } : { status: 'missing' },
  };
}

export type KindScore = { passed: number; total: number };

/** Pass counts per kind. The planted kinds measure different mechanisms and are reported apart. */
export function scoreByKind(grades: readonly Pick<LakeRagGrade, 'kind' | 'passed'>[]): Record<LakeRagKind, KindScore> {
  const scores = Object.fromEntries(LAKE_RAG_KINDS.map(kind => [kind, { passed: 0, total: 0 }])) as Record<
    LakeRagKind,
    KindScore
  >;
  for (const grade of grades) {
    scores[grade.kind].total += 1;
    if (grade.passed) scores[grade.kind].passed += 1;
  }
  return scores;
}
