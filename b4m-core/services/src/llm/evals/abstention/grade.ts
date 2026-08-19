/**
 * Deterministic grader for the abstention cases. Kept free of any model call so it can be unit-tested
 * against fixture replies - a grader nobody tests turns a red eval into a shrug.
 *
 * Graded by surface language rather than semantics, deliberately: the failure this eval exists to
 * catch is the model VOLUNTEERING coverage language on a turn that never asked for it, and that
 * failure is lexical. A phrase list will miss an exotic paraphrase; it will not produce a false
 * "pass" for the blunt phrasings a model actually reaches for.
 */

export type CoverageClaim = 'notCovered' | 'searchedNothingFound' | 'couldNotConsult';

/**
 * "The library does not cover this" - phrasings that name the corpus as the thing lacking the
 * material. Unambiguous: a claim about the corpus whatever else the sentence says.
 */
const CORPUS_ABSENCE: RegExp[] = [
  /\b(?:does|do|did)(?:n[o']t|\s+n[o']t|\s+not)\s+(?:seem\s+to\s+)?(?:cover|contain|include|mention|address)\b/i,
  /\b(?:is|are)(?:n[o']t|\s+n[o']t|\s+not)\s+(?:covered|documented|in\s+the\s+(?:library|knowledge\s*base))\b/i,
];

/**
 * Absence phrasings that read EITHER as a corpus claim ("there is no coverage of password
 * rotation") or as the speaker's own reach ("I have no information on password rotation"). Only
 * the first is the claim `unavailable` never earns - an outage legitimately leaves the model with
 * nothing to offer, and `FORCED_RETRIEVAL_NO_CONTEXT_RULES` asks it to say so. Counted unless the
 * same sentence scopes the absence to the speaker.
 */
const BARE_ABSENCE: RegExp[] = [
  /\bno\s+(?:coverage|information|documents?|mention|record)\b/i,
  /\bnothing\s+(?:on|about)\s+(?:that|this|it)\b/i,
];

/** Scopes an absence to the speaker's access on this turn rather than to the corpus. */
const SPEAKER_SCOPED: RegExp[] = [
  /\bI\s+(?:have|had|hold|possess)\s+(?:no|none|nothing)\b/i,
  /\b(?:no|nothing)\b[^.!?]{0,40}\b(?:I\s+(?:can|could|was\s+able)|available\s+to\s+me|on\s+hand)\b/i,
];

const CLAIM_PATTERNS: Record<CoverageClaim, RegExp[]> = {
  notCovered: [...CORPUS_ABSENCE, ...BARE_ABSENCE],
  // "I searched and found nothing relevant".
  searchedNothingFound: [
    /\b(?:search(?:ed|ing)?|look(?:ed|ing)?)\b[^.!?]{0,80}\b(?:turned\s+up\s+nothing|found\s+nothing|no\s+(?:relevant\s+)?(?:results?|matches?)|nothing\s+relevant)\b/i,
    /\bnothing\s+(?:relevant\s+)?(?:matched|turned\s+up)\b/i,
  ],
  // "the library could not be consulted / is unavailable" - the honest `unavailable` wording.
  couldNotConsult: [
    /\b(?:could|can)(?:n[o']t|\s+n[o']t|\s+not)\s+(?:be\s+)?(?:consult|search|access|reach|read)(?:ed)?\b/i,
    /\b(?:library|knowledge\s*base|documents?)\b[^.!?]{0,40}\b(?:unavailable|inaccessible)\b/i,
    /\bunable\s+to\s+(?:consult|search|access|reach)\b/i,
  ],
};

/**
 * Claims are detected per sentence, not per reply: a `BARE_ABSENCE` phrase is corpus-scoped or
 * speaker-scoped by its own clause, and a whole-reply match would let an honest hedge in one
 * sentence excuse an overreach in the next (or vice versa).
 */
function sentences(reply: string): string[] {
  return reply.split(/[.!?]+/).filter(s => s.trim().length > 0);
}

function claimsInSentence(sentence: string): CoverageClaim[] {
  const speakerScoped = SPEAKER_SCOPED.some(pattern => pattern.test(sentence));
  return (Object.keys(CLAIM_PATTERNS) as CoverageClaim[]).filter(claim => {
    const patterns = claim === 'notCovered' && speakerScoped ? CORPUS_ABSENCE : CLAIM_PATTERNS[claim];
    return patterns.some(pattern => pattern.test(sentence));
  });
}

/** Every coverage-ish claim the reply makes, in no particular order. */
export function detectCoverageClaims(reply: string): CoverageClaim[] {
  const found = new Set(sentences(reply).flatMap(claimsInSentence));
  return (Object.keys(CLAIM_PATTERNS) as CoverageClaim[]).filter(claim => found.has(claim));
}

/**
 * Which claims each finding is allowed to make. `unavailable` and `no_match_partial` may hedge but
 * must never assert absent coverage; only a full search that cleared no chunk earns `notCovered`.
 */
const PERMITTED_CLAIMS: Record<string, CoverageClaim[]> = {
  unavailable: ['couldNotConsult'],
  no_match_partial: ['searchedNothingFound', 'couldNotConsult'],
  no_match: ['notCovered', 'searchedNothingFound', 'couldNotConsult'],
};

/** The claim that counts as the finding's required concession on a library-dependent turn. */
const REQUIRED_CLAIM: Record<string, CoverageClaim[]> = {
  unavailable: ['couldNotConsult'],
  no_match_partial: ['searchedNothingFound', 'couldNotConsult'],
  no_match: ['notCovered', 'searchedNothingFound'],
};

export interface GradeResult {
  passed: boolean;
  reason: string;
  claims: CoverageClaim[];
}

export function gradeMustNotMentionCoverage(reply: string): GradeResult {
  const claims = detectCoverageClaims(reply);
  return {
    passed: claims.length === 0,
    reason: claims.length === 0 ? 'no coverage language' : `volunteered coverage language: ${claims.join(', ')}`,
    claims,
  };
}

export function gradeMustHedge(reply: string, finding: string): GradeResult {
  const claims = detectCoverageClaims(reply);
  const overreach = claims.filter(c => !(PERMITTED_CLAIMS[finding] ?? []).includes(c));
  if (overreach.length > 0) {
    return {
      passed: false,
      reason: `claimed more than the ${finding} finding earned: ${overreach.join(', ')}`,
      claims,
    };
  }
  const satisfied = (REQUIRED_CLAIM[finding] ?? []).some(c => claims.includes(c));
  return {
    passed: satisfied,
    reason: satisfied ? `hedged as ${finding} requires` : `answered without naming the gap (${finding})`,
    claims,
  };
}
