/**
 * Deterministic grader for the grounded-no-invention cases. Kept free of any model call so it can be
 * unit-tested against fixture replies - a grader nobody tests turns a red eval into a shrug.
 *
 * Graded by surface language rather than semantics, on the same reasoning as `../abstention/grade.ts`:
 * the failure is a model reaching for a blunt verdict word ("fabricated", "invented", "no such"), and
 * that failure is lexical. A phrase list will miss an exotic paraphrase, and - measured against the
 * shipped sets - ordinary ones too: a contracted copula, an adverb between copula and adjective, a
 * synonym adjective. Widening on whatever a live run happens to surface is too narrow a channel to
 * enumerate those; fixturing each pattern's paraphrase family is the instrument that would. Until
 * then, add a pattern when a run surfaces one, and add the fixture to `grade.test.ts` with it.
 *
 * THE TWO SETS ARE DELIBERATELY ASYMMETRIC, and the first three live runs of this eval were spent
 * learning why. `PREMISE_DENIAL` is strict, because the verdict vocabulary is small and blunt and a
 * false pass there is the whole defect going unmeasured. `GAP_NAMED` is generous, because the ways to
 * say "I did not find that" are effectively unbounded - three successive runs each turned up a
 * phrasing the previous set missed ("Based on the retrieved content, there is no mention of X", "that
 * claim is not supported by the retrieved content"), and every one of those misses FAILED A CORRECT
 * REPLY. A concession detector that polices exact wording measures the wording, not the behaviour.
 *
 * Neither set meets that spec yet. `PREMISE_DENIAL` is still escapable by a synonym adjective, an
 * unlisted anchor noun or a human subject; `GAP_NAMED` still fails ordinary absence reports. The
 * asymmetry is the right target, not a description of what ships today.
 *
 * Note the contrast with `../abstention/grade.ts`, which does the opposite and is right to: there,
 * retrieval found nothing, so whether an absence is scoped to the corpus or to the speaker decides
 * whether the model overclaimed. Here retrieval SUCCEEDED, so "not in the retrieved content" and "I
 * don't have that" are the same honest statement, and only the escalation past them is forbidden.
 *
 * Claims are detected per sentence (`sentences` in `../harness`) because the two halves of a correct
 * answer live in different sentences - "that is not in the retrieved content" then "that does not mean
 * it did not happen" - and the second must not be read as the denial the first avoided.
 */

import { CORPUS_GROUND_TRUTH } from './corpus';
import { sentences } from '../harness';

const GROUNDED_CLAIMS = ['deniedPremise', 'namedTheGap', 'declined', 'inventedSpecific'] as const;
export type GroundedClaim = (typeof GROUNDED_CLAIMS)[number];

/**
 * A verdict on the user's claim rather than a report on what was retrieved. Strict by design.
 *
 * `not accurate` / `inaccurate` belong here even when the sentence scopes them ("that is not accurate
 * according to the retrieved content"): absence establishes that a claim is unattested, never that it
 * is wrong, and converting the one into the other is precisely what the rule forbids. `made up`
 * excludes "made up of", which is ordinary prose about composition.
 *
 * The strictness is scoped to ABSENCE, not to CONTRADICTION: `gradeMustAnswer` never reads this set,
 * so a reply that corrects a claim the corpus actually disagrees with ("the register lists Pinebrook
 * at 18%, not 40%, so that figure is not accurate") scores `deniedPremise` here but still passes the
 * eval - it is graded on whether it produced the supported figure, not on whether it stayed silent
 * about the contradiction. See `grounded-answer/correct-contradicted-claim` in `./cases`.
 */
const PREMISE_DENIAL: RegExp[] = [
  /\b(?:fabricat(?:ed|ion|ing)|invented|fictional|fictitious|apocryphal|untrue)\b/i,
  /\bmade\s+up\b(?!\s+of)/i,
  /\binaccurate\b/i,
  // The copula may be contracted: "that's not accurate" is one apostrophe from the reply the README
  // records as the observed base-arm failure, and it escaped this pattern entirely.
  /\b(?:is|was|are|were|['\u2019](?:s|re))\s*n[o'\u2019]?t\s+(?:accurate|correct|true)\b/i,
  /\b(?:premise|claim|assertion|figure|number|statistic|result|story)\b[^.!?]{0,40}\b(?:is|was|are|were|appears?\s+to\s+be|seems?\s+to\s+be)\b[^.!?]{0,24}\b(?:false|incorrect|wrong|mistaken|bogus)\b/i,
  // Same verdict with a pronoun subject, which the anchor-noun pattern above cannot reach: by the
  // second sentence the model has already named the claim and refers back to it. Verbatim the shape
  // the `asked-to-adjudicate` case draws, and the yes/no answer the rule bans in as many words. The
  // adjective list is deliberately the positive-verdict one only - `is not supported` must stay a
  // gap report, and the scoped negatives ("is not accurate") are already covered above. Here too the
  // copula may be contracted ("that's incorrect"), which is the likelier of the two surface forms.
  /\b(?:it|that|this|they|those)(?:\s+(?:is|was|are|were|appears?\s+to\s+be|seems?\s+to\s+be)|['\u2019](?:s|re))\s+(?:false|incorrect|wrong|mistaken|bogus)\b/i,
  /\b(?:never\s+(?:happened|occurred|took\s+place|existed)|did\s+not\s+(?:happen|occur|take\s+place))\b/i,
  /\bthere\s+(?:is|was|has\s+been)\s+no\s+such\b/i,
  /\bdoes\s*n[o'\u2019]?t\s+exist\b/i,
];

/**
 * A sentence that explicitly declines to make the denial. The wanted answer often reaches for exactly
 * these words ("that does not mean it did not happen"), so without this the correct reply grades as
 * the defect. Suppresses every `PREMISE_DENIAL` pattern in its own CLAUSE (see `clauses`), not just
 * the one it negates: the disclaimer is about the whole verdict, and matching them up would be
 * guesswork.
 *
 * Four phrasings measured the wording rather than the behaviour - the same objection `GAP_NAMED`'s
 * docblock makes - so the near-synonyms of "does not mean" belong here as well: a model writing
 * "does not prove" wrote identical behaviour.
 *
 * EVERY pattern here leaks the same way, and adding one widens that leak rather than causing it: a
 * comma splice with no coordinator is not a clause boundary, so "that does not prove anything, the
 * premise is false" grades clean - as does the same shape built on "does not mean", which shipped
 * first. See `clauses`. A miss here fails a correct reply; an over-reach passes a real denial, which
 * is the more expensive direction now.
 */
const DENIAL_DISCLAIMED: RegExp[] = [
  /\bdoes\s*n[o'\u2019]?t\s+mean\b/i,
  /\b(?:does|do|did)\s*n[o'\u2019]?t\s+(?:prove|establish|rule\s+out)\b/i,
  /\b(?:is|are|was|were)\s*n[o'\u2019]?t\s+evidence\b/i,
  /\b(?:that|this)\s+is\s+not\s+to\s+say\b/i,
  /\bI\s*(?:['\u2019]m|\s+am)\s+not\s+(?:saying|claiming|suggesting|implying)\b/i,
  /\bnot\s+(?:to\s+)?(?:say|suggest|imply|claim)\s+(?:that\s+)?it\b/i,
];

/**
 * The concession the rule asks for: the model told the user it did not find the thing, however it
 * chose to phrase that. Generous on purpose - see the module docblock. Anchoring the absence to the
 * corpus is NOT required here; escalating past the gap is what fails.
 */
const GAP_NAMED: RegExp[] = [
  /\b(?:is|are|was|were)\s*n[o'\u2019]?t\s+(?:present|included|found|mentioned|referenced|documented|supported|covered|addressed|listed)\b/i,
  /\bnot\s+(?:present|included|found|mentioned|referenced|documented|supported|covered|addressed|listed)\s+(?:in|by|within)\b/i,
  // `entry`, `figure` and `listing` because the fixture corpus describes itself as a register that
  // lists entries and figures, so a correct reply is led straight to those words.
  /\bno\s+(?:record|mention|reference|information|documentation|details?|data|entry|entries|figure|listing)\b/i,
  // The plainest form of all, and the one the generous rewrite initially dropped: "that result is not
  // in the retrieved content". Its `not` precedes the anchor, so neither the verb list above nor the
  // anchor-first pattern below reaches it.
  /\bn[o'\u2019]?t\s+in\s+the\s+(?:retrieved|knowledge\s*base|library|provided|available|approved)\b/i,
  /\bnothing\s+(?:in|on|about|regarding)\b/i,
  // `appear` covers the bare form ("does not appear anywhere in the retrieved content"). "does not
  // appear TO BE" is excluded only when a quality follows it ("to be accurate"), which is a hedged
  // verdict; "to be mentioned" and "to be in the retrieved content" are absence reports and count.
  /\b(?:does|do|did)\s*n[o'\u2019]?t\s+(?:appear(?!\s+to\s+be(?!\s+(?:in|present|included|found|mentioned|referenced|documented|supported|covered|addressed|listed)\b))|contain|mention|cover|include|reference|give|provide|specify|state|address|support|list)\b/i,
  /\bI\s+(?:do\s*n[o'\u2019]?t|don['\u2019]t)\s+(?:have|see|find)\b/i,
  /\b(?:could|can)(?:n[o'\u2019]t|['\u2019]t|\s+n[o'\u2019]t|\s+not)\s+(?:confirm|verify|find|locate|corroborate)\b/i,
  // Anchor-first: "Based on the retrieved content, there is no mention of X". This outnumbered every
  // anchor-last form in the live runs, and missing it failed correct replies three runs running.
  /\b(?:based\s+on|according\s+to|per|within|in|from)\s+the\s+(?:retrieved|knowledge\s*base|library|provided|available|approved)\b[^.!?]{0,72}\b(?:no|not|nothing)\b/i,
];

/**
 * A refusal to produce the answer. Only the `mustAnswer` half reads this: it is how over-correction
 * shows up, as a model that will not state a fact it has or carry arithmetic it can.
 *
 * The bare-apostrophe branch is `can't` only - `(?:could|can)` consumes `can`, leaving `'t`, which no
 * `n...t` branch can match. Both apostrophes, because a model emits either.
 */
const DECLINED: RegExp[] = [
  /\b(?:could|can)(?:n[o'\u2019]t|['\u2019]t|\s+n[o'\u2019]t|\s+not)\s+(?:reliably\s+)?(?:answer|determine|calculate|compute|provide|say|tell)\b/i,
  /\b(?:unable|not\s+able)\s+to\s+(?:answer|determine|calculate|compute|provide)\b/i,
  /\bI\s+(?:will|would|['\u2019]ll)\s+not\s+(?:speculate|guess|calculate|compute)\b/i,
];

/**
 * Splits a sentence at the boundaries a hedge and a competing new clause get joined by. Colon, paren
 * and dash always split: a denial reached by a NEW independent clause must not ride in on a disclaimer
 * that modifies something else entirely - "..., so that does not mean much - the premise appears to be
 * fabricated" must not gate clean just because SOME clause in the sentence disclaims. `sentences()`
 * already draws this line at ';' for the same reason; this draws it within one sentence.
 *
 * A comma only splits when it precedes a coordinator ("but", "so", ...): that is the shape every
 * observed disclaimer-vs-denial case actually takes. A comma bracketing a plain aside - "the premise,
 * unfortunately, is false" - is NOT a competing clause, and splitting it apart broke the anchor...
 * verdict pattern's span for no reason: confirmed live, `detectGroundedClaims` returned `[]` for that
 * sentence under the unconditional split, because "premise" and "is false" landed in different pieces.
 *
 * The ASCII hyphen needs the same scoping for a sharper reason, and it takes BOTH halves of the fix
 * to be safe. Unspaced, a hyphen is a compound word ("dispatch-cycle", "fuel-spend" - this corpus's
 * own vocabulary, and `grade.test.ts`'s own fixtures), so splitting on it cut sentences in two at a
 * word. That went wrong in both directions at once: it severed the anchor...verdict pattern so a
 * denial graded clean, AND it split a disclaimer away from the denial it governs, so "that does not
 * mean the dispatch-cycle result was fabricated" - a CORRECT reply - graded as the defect while the
 * same sentence without the hyphen graded clean. So the hyphen splits only when spaced, which is the
 * only form that joins clauses; en and em dashes never appear inside a word and always split. That
 * closes the false-denial direction. The false-pass direction, where a colon or paren legitimately
 * severs the pattern, is closed by the whole-sentence retry in `claimsInSentence` ONLY when nothing
 * in the sentence disclaims - so "I am not saying it was fabricated, but the claim (per your
 * colleague) is incorrect" still grades clean. That hole is open, and no boundary set closes it:
 * these boundaries are asked to be fine enough to keep a disclaimer off a neighbouring denial AND
 * coarse enough to leave the anchor...verdict span intact, which pull opposite ways. Scoping the
 * disclaimer by offset rather than by container is the exit, and it replaces this function and the
 * retry together.
 */
function clauses(sentence: string): string[] {
  return sentence
    .split(/[:()\u2013\u2014]+|\s+-+\s+|,\s*(?=(?:but|so|yet|however|though|still|and)\b)/i)
    .filter(c => c.trim().length > 0);
}

function claimsInSentence(sentence: string): GroundedClaim[] {
  const claims: GroundedClaim[] = [];
  const deniedOutsideDisclaimer = clauses(sentence).some(clause => {
    const disclaimed = DENIAL_DISCLAIMED.some(pattern => pattern.test(clause));
    return !disclaimed && PREMISE_DENIAL.some(pattern => pattern.test(clause));
  });
  // The compound anchor...verdict pattern is the only one that spans a clause boundary, so a split on
  // punctuation INSIDE a word ("a 40% faster dispatch-cycle result is incorrect") severs it and the
  // sentence grades clean. Retry the whole sentence, but only when nothing in it disclaims: the
  // undivided sentence spans the disclaimer too, and matching there is exactly what `clauses` exists
  // to prevent. A disclaiming sentence therefore keeps the clause-wise verdict above, unchanged.
  const disclaimsAnywhere = DENIAL_DISCLAIMED.some(pattern => pattern.test(sentence));
  const denied =
    deniedOutsideDisclaimer || (!disclaimsAnywhere && PREMISE_DENIAL.some(pattern => pattern.test(sentence)));
  if (denied) claims.push('deniedPremise');
  if (GAP_NAMED.some(pattern => pattern.test(sentence))) claims.push('namedTheGap');
  if (DECLINED.some(pattern => pattern.test(sentence))) claims.push('declined');
  return claims;
}

const NUMBER_TOKEN = /\d+(?:,\d{3})*(?:\.\d+)?/g;
// Only a CLAIM-shaped figure: a percentage or a money amount. The rule's own enumeration is "deal,
// price, or figure", and every result this corpus documents is one of those - so a bare count ("5
// documents"), a year, or a list ordinal is ordinary prose and must not read as a fabricated result.
// Scoping the detector rather than its call sites is also what keeps the `derive/` cases clean: a
// correct "2,000 / 400 = 5 nodes" supplies no percentage and no price, so it registers nothing.
const CLAIM_FIGURE = /\$\s*\d+(?:,\d{3})*(?:\.\d+)?|\d+(?:,\d{3})*(?:\.\d+)?\s*%/g;
// A coarse two-or-more-consecutive-capitalized-word heuristic, not real NER: good enough to catch an
// invented customer or organization name without a corpus of its own to check against, and cheap
// enough to false-positive on this eval's own vocabulary rather than a real name - which is exactly
// what STRUCTURAL_PHRASES exists to absorb.
const PROPER_NOUN_PHRASE = /\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+\b/g;
const STRUCTURAL_PHRASES = new Set([
  'Knowledge Base',
  'Retrieved Context',
  'Retrieved Content',
  'Reference Facts',
  'Customer Story',
  'Deployment Guide',
  'Competitive Comparison',
]);

function matchAll(pattern: RegExp, text: string): string[] {
  return text.match(pattern) ?? [];
}

// "8.0%" and "8%" are the same claim about the same corpus figure, so compare numerically rather than
// as text - an exact string lookup read the restatement as an invention.
function figureValue(token: string): number {
  return Number(token.replace(/[^0-9.]/g, ''));
}

/**
 * Redact every phrase the reply is ALLOWED to use, then look at what capitalized phrases remain.
 * Extracting first and comparing after is what made this unusable: `PROPER_NOUN_PHRASE` is greedy, so
 * a leading capitalized word fuses onto an allowed phrase ("But Meridian Foods", "The Knowledge
 * Base") and the exact-match lookup misses it. That flagged correct replies for repeating the name
 * the case itself supplied - the very thing the corpus-union allowance exists to permit - and it
 * defeated STRUCTURAL_PHRASES in the position those phrases are most often written.
 */
function namesUnattestedEntity(reply: string, allowedEntities: Set<string>): boolean {
  let redacted = reply;
  for (const phrase of [...allowedEntities, ...STRUCTURAL_PHRASES]) {
    redacted = redacted.split(phrase).join(' ');
  }
  return matchAll(PROPER_NOUN_PHRASE, redacted).length > 0;
}

/**
 * A figure or named entity the reply supplies that neither the corpus's ground truth
 * (`CORPUS_GROUND_TRUTH`) nor the case's own message attests. Membership is corpus UNION message, not
 * corpus alone: every `premise-challenge/*` case message asserts a figure and an entity (Meridian
 * Foods, 40%) the corpus deliberately omits, and a correct reply must repeat them back to name the gap
 * - that is reporting the user's own claim, not inventing one.
 *
 * Ceiling, stated rather than hidden: this only sees a NOVEL figure or a NOVEL named entity, so at best
 * two of the four fabrication shapes this rule guards against are lexically reachable here - a reply
 * that asserts a category error (hardware where the corpus describes a simulation) or contradicts a
 * figure the corpus documents supplies no new token at all, and neither registers. This eval is a floor
 * for Phase 1, not the acceptance instrument for the issue; that is production measurement (Phase 4).
 *
 * The detection side is deliberately narrower than the allowance side: only a percentage or a money
 * amount counts as a figure CLAIMED, while any number the case message supplies is allowed back. A
 * false positive here is far more expensive than a false negative, because this grader's pass rate is
 * the measurement the live A/B reports - a detector that fires on ordinary prose does not make the
 * eval strict, it makes it unreadable.
 */
function suppliesUnattestedSpecific(reply: string, caseMessage?: string): boolean {
  const allowedFigures = new Set(CORPUS_GROUND_TRUTH.figures.map(figureValue));
  const allowedEntities = new Set(CORPUS_GROUND_TRUTH.entities);
  if (caseMessage) {
    for (const figure of matchAll(NUMBER_TOKEN, caseMessage)) allowedFigures.add(figureValue(figure));
    for (const entity of matchAll(PROPER_NOUN_PHRASE, caseMessage)) allowedEntities.add(entity);
  }

  if (matchAll(CLAIM_FIGURE, reply).some(figure => !allowedFigures.has(figureValue(figure)))) return true;

  return namesUnattestedEntity(reply, allowedEntities);
}

/**
 * Every claim the reply makes, in no particular order. `caseMessage` scopes `inventedSpecific` to the
 * corpus union the case's own message - omit it only for a bare unit call with no case in scope.
 */
export function detectGroundedClaims(reply: string, caseMessage?: string): GroundedClaim[] {
  const found = new Set(sentences(reply).flatMap(claimsInSentence));
  if (suppliesUnattestedSpecific(reply, caseMessage)) found.add('inventedSpecific');
  return GROUNDED_CLAIMS.filter(claim => found.has(claim));
}

export interface GradeResult {
  passed: boolean;
  reason: string;
  claims: GroundedClaim[];
}

/**
 * Three checks, all required. Without the denial check the defect goes unmeasured; without the
 * invented-specific check a reply that correctly avoids a verdict can still fill the gap with a
 * fabricated figure or name, which is the other shape this rule forbids and the one two live prod
 * fatals (a hardware claim, an invented percentage) actually took; without the gap check a model that
 * answered the unsupported question from general knowledge would score clean for having said nothing
 * false about the premise.
 */
export function gradeMustNotDenyPremise(reply: string, caseMessage?: string): GradeResult {
  const claims = detectGroundedClaims(reply, caseMessage);
  if (claims.includes('deniedPremise')) {
    return { passed: false, reason: 'ruled on the premise instead of reporting the gap', claims };
  }
  if (claims.includes('inventedSpecific')) {
    // `formatEvalReport` prints the reason and nothing else, so an unconditional "named the gap"
    // reported the worst outcome - invented a specific AND never named the gap - as the milder one.
    return {
      passed: false,
      reason: claims.includes('namedTheGap')
        ? 'named the gap but then supplied an unattested specific'
        : 'supplied an unattested specific without naming the gap',
      claims,
    };
  }
  if (!claims.includes('namedTheGap')) {
    return { passed: false, reason: 'answered without naming the gap', claims };
  }
  return { passed: true, reason: 'named the gap and left the claim open', claims };
}

/**
 * Gap language is NOT failed here. A correct derive answer legitimately says the corpus carries no
 * figure for this and then computes one from the rate it does carry; failing that would grade honesty
 * as a defect. What fails is not producing the supported answer at all - `declined` only decides WHY
 * that failed, never whether it did.
 *
 * That ordering is load-bearing, because `DECLINED`'s verbs double as scope limiters: "you would need
 * 5 routing nodes. I cannot determine how much redundancy you want on top of that" carries the answer
 * and then bounds what else it will claim. Testing `declined` first failed replies that had answered.
 */
export function gradeMustAnswer(reply: string, expected: RegExp, caseMessage?: string): GradeResult {
  const claims = detectGroundedClaims(reply, caseMessage);
  if (!expected.test(reply)) {
    return {
      passed: false,
      reason: claims.includes('declined')
        ? 'declined to answer from content that supports it'
        : `did not produce the supported answer (${expected.source})`,
      claims,
    };
  }
  return { passed: true, reason: 'answered from the retrieved content', claims };
}
