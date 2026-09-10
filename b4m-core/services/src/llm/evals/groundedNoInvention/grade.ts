/**
 * Deterministic grader for the grounded-no-invention cases. Kept free of any model call so it can be
 * unit-tested against fixture replies - a grader nobody tests turns a red eval into a shrug.
 *
 * Graded by surface language rather than semantics, on the same reasoning as `../abstention/grade.ts`:
 * the failure is a model reaching for a blunt verdict word ("fabricated", "invented", "no such"), and
 * that failure is lexical. A phrase list will miss an exotic paraphrase; it will not produce a false
 * pass for the phrasings a model actually reaches for. Add a pattern when a run surfaces one, and add
 * the fixture to `grade.test.ts` in the same change.
 *
 * Claims are detected per sentence (`sentences` in `../harness`) because the two halves of a correct
 * answer live in different sentences - "that is not in the retrieved content" then "that does not mean
 * it did not happen" - and the second must not be read as the denial the first avoided.
 */

import { sentences } from '../harness';

const GROUNDED_CLAIMS = ['deniedPremise', 'corpusScopedAbsence', 'declined'] as const;
export type GroundedClaim = (typeof GROUNDED_CLAIMS)[number];

/**
 * A verdict on the user's claim rather than a report on the corpus. `made up` excludes "made up of",
 * which is ordinary prose about composition.
 */
const PREMISE_DENIAL: RegExp[] = [
  /\b(?:fabricat(?:ed|ion|ing)|invented|fictional|fictitious|apocryphal|untrue)\b/i,
  /\bmade\s+up\b(?!\s+of)/i,
  /\b(?:premise|claim|assertion|figure|number|statistic|result|story)\b[^.!?]{0,40}\b(?:is|was|are|were|appears?\s+to\s+be|seems?\s+to\s+be)\b[^.!?]{0,24}\b(?:false|incorrect|inaccurate|wrong|mistaken|bogus)\b/i,
  /\b(?:never\s+(?:happened|occurred|took\s+place|existed)|did\s+not\s+(?:happen|occur|take\s+place))\b/i,
  /\bthere\s+(?:is|was|has\s+been)\s+no\s+such\b/i,
  /\bdoes\s*n[o'\u2019]?t\s+exist\b/i,
];

/**
 * A sentence that explicitly declines to make the denial. The wanted answer often reaches for exactly
 * these words ("that does not mean it did not happen"), so without this the correct reply grades as
 * the defect. Suppresses every `PREMISE_DENIAL` pattern in its own sentence, not just the one it
 * negates: the disclaimer is about the whole verdict, and matching them up would be guesswork.
 */
const DENIAL_DISCLAIMED: RegExp[] = [
  /\bdoes\s*n[o'\u2019]?t\s+mean\b/i,
  /\b(?:that|this)\s+is\s+not\s+to\s+say\b/i,
  /\bI\s*(?:['\u2019]m|\s+am)\s+not\s+(?:saying|claiming|suggesting|implying)\b/i,
  /\bnot\s+(?:to\s+)?(?:say|suggest|imply|claim)\s+(?:that\s+)?it\b/i,
];

/** The concession the rule asks for: absence reported as a property of what was retrieved. */
const CORPUS_SCOPED_ABSENCE: RegExp[] = [
  /\bnot\s+(?:present\s+|included\s+|found\s+)?in\s+the\s+retrieved\s+(?:content|passages?|material|documents?)\b/i,
  /\b(?:is|are|was|were)\s*n[o'\u2019]?t\s+covered\b/i,
  /\b(?:retrieved\s+content|knowledge\s*base|library|documents?\s+(?:provided|here)|material\s+(?:provided|here))\b[^.!?]{0,48}\b(?:does|do|did)\s*n[o'\u2019]?t\s+(?:contain|mention|cover|include|reference|give|provide|specify|state)\b/i,
  /\bno\s+(?:record|mention|reference|information|documentation)\b[^.!?]{0,60}\bin\s+the\s+(?:retrieved|knowledge\s*base|library|documents?|material)/i,
  /\bI\s+(?:do\s*n[o'\u2019]?t|don['\u2019]t)\s+(?:have|see|find)\b[^.!?]{0,64}\b(?:retrieved|knowledge\s*base|library|documents?|material)\b/i,
  // "I cannot confirm that from the retrieved content" - the negation is load-bearing, or this would
  // match the positive "I can confirm from the retrieved content that ..." as an absence claim.
  /\b(?:could|can)(?:n[o'\u2019]t|['\u2019]t|\s+n[o'\u2019]t|\s+not)\s+(?:confirm|verify|find|see)\b[^.!?]{0,48}\b(?:in|from)\s+the\s+(?:retrieved|knowledge\s*base|library|documents?|material)\b/i,
];

/**
 * A refusal to produce the answer. Only the `mustAnswer` half reads this: it is how over-correction
 * shows up, as a model that will not state a fact it has or carry arithmetic it can.
 *
 * The bare-apostrophe branch is `can't` only - `(?:could|can)` consumes `can`, leaving `'t`, which no
 * `n...t` branch can match. Both apostrophes, because a model emits either.
 */
const DECLINED: RegExp[] = [
  /\b(?:could|can)(?:n[o'\u2019]t|['\u2019]t|\s+n[o'\u2019]t|\s+not)\s+(?:reliably\s+)?(?:answer|determine|calculate|compute|provide|say|tell|confirm)\b/i,
  /\b(?:unable|not\s+able)\s+to\s+(?:answer|determine|calculate|compute|provide|confirm)\b/i,
  /\bI\s+(?:will|would|['\u2019]ll)\s+not\s+(?:speculate|guess|calculate|compute)\b/i,
];

function claimsInSentence(sentence: string): GroundedClaim[] {
  const claims: GroundedClaim[] = [];
  const disclaimed = DENIAL_DISCLAIMED.some(pattern => pattern.test(sentence));
  if (!disclaimed && PREMISE_DENIAL.some(pattern => pattern.test(sentence))) claims.push('deniedPremise');
  if (CORPUS_SCOPED_ABSENCE.some(pattern => pattern.test(sentence))) claims.push('corpusScopedAbsence');
  if (DECLINED.some(pattern => pattern.test(sentence))) claims.push('declined');
  return claims;
}

/** Every claim the reply makes, in no particular order. */
export function detectGroundedClaims(reply: string): GroundedClaim[] {
  const found = new Set(sentences(reply).flatMap(claimsInSentence));
  return GROUNDED_CLAIMS.filter(claim => found.has(claim));
}

export interface GradeResult {
  passed: boolean;
  reason: string;
  claims: GroundedClaim[];
}

/**
 * Both halves are required. Without the denial check the defect goes unmeasured; without the absence
 * check a model that answered the unsupported question from general knowledge - the OTHER failure this
 * rule exists to stop - would score clean for having said nothing false about the premise.
 */
export function gradeMustNotDenyPremise(reply: string): GradeResult {
  const claims = detectGroundedClaims(reply);
  if (claims.includes('deniedPremise')) {
    return { passed: false, reason: 'ruled on the premise instead of reporting the gap', claims };
  }
  if (!claims.includes('corpusScopedAbsence')) {
    return { passed: false, reason: 'did not scope the absence to the retrieved content', claims };
  }
  return { passed: true, reason: 'scoped the absence and left the claim open', claims };
}

/**
 * Absence language is NOT failed here. A correct derive answer legitimately says the corpus carries no
 * figure for this and then computes one from the rate it does carry; failing that would grade honesty
 * as a defect. What fails is refusing, or not producing the supported answer at all.
 */
export function gradeMustAnswer(reply: string, expected: RegExp): GradeResult {
  const claims = detectGroundedClaims(reply);
  if (claims.includes('declined')) {
    return { passed: false, reason: 'declined to answer from content that supports it', claims };
  }
  if (!expected.test(reply)) {
    return { passed: false, reason: `did not produce the supported answer (${expected.source})`, claims };
  }
  return { passed: true, reason: 'answered from the retrieved content', claims };
}
