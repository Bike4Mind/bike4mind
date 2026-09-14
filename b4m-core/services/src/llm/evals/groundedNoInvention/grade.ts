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
 *
 * `suppliedTheClaim` is the fourth class and the newest. Denial and supply are the two halves of ONE
 * instruction - "report the gap and leave the claim open" - so they live in one grader: a grader that
 * scores only the denial half lets a reword trade one for the other invisibly, which is exactly how
 * the supply failure shipped. Only `gradeMustNotDenyPremise` reads it; see `gradeMustAnswer`.
 *
 * WHAT IT MISSES, stated plainly because the set is narrow on purpose. It reads two signals: a
 * PERCENTAGE in neither the corpus nor the user's own question, and a general-knowledge FRAME. A
 * purely qualitative elaboration - an invented mechanism or comparison baseline carrying no
 * percentage and no frame phrase - grades clean, and two of the four reported turns are that shape.
 * Reaching them needs a semantic check of whether an assertion is corpus-backed, which no pattern
 * does. Five narrowings are deliberate, each bought precision at the cost of reach:
 *  - only PERCENTAGES are scanned in the reply, not every number. Scanning bare numbers failed
 *    correct replies on their own bookkeeping ("I checked all 5 documents"), and all the reported
 *    supply figures were percentages. A fabricated non-percentage specific (a dollar value, a
 *    duration) is therefore not caught.
 *  - the allowlist is every number the corpus states, not only its percentages, so a reply quoting
 *    "15 to 20%" - where the corpus signs only the 20 - does not read as inventing the 15. It is a
 *    FLAT set with no link back to the section a number came from, so an invented percentage that
 *    collides with any number anywhere in the corpus is licensed: 25 (the competitive section's
 *    "no competitor above 25%"), 400 (a shipments-per-hour rate) and 2024 (a year) all escape.
 *  - the frame signal is suppressed in a sentence that names the gap, because a gap report may
 *    legitimately say where to look instead. A supply riding in the SAME sentence as the gap report
 *    escapes; the observed shape puts it in a later one.
 *  - the generalisation half of the frame needs a demonstrative pointing BACK at the absent result
 *    ("gains of that size", "rollouts like that") as well as a result noun. That is what separates a
 *    supply from the pointer the rule licenses, which is written in the same vocabulary - see
 *    `DEMONSTRATIVE_BACKREF`. A generalisation that asserts something about the absent result without
 *    a demonstrative ("gains in this sector come from X") escapes, as does one whose noun is outside
 *    `SUPPLIED_SPECIFIC`.
 *  - a supply is suppressed when a negation governs it: earlier in the same clause, with no comma
 *    between (see `framedAsGeneralKnowledge`). That is the use-versus-mention gate, and it is
 *    positional because the rule's own prohibition names the frame's words verbatim. A refusal
 *    phrased AFTER the source it refuses does not suppress.
 */

import { sentences } from '../harness';
import { CORPUS_FIGURES, figuresIn, normaliseFigure } from './corpus';

const GROUNDED_CLAIMS = ['deniedPremise', 'namedTheGap', 'declined', 'suppliedTheClaim'] as const;
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
 * The model sourcing a specific from outside the retrieved content. Two shapes: naming a body of
 * outside knowledge ("published benchmarks show"), and generalising ("gains like that are typically
 * ..."), which is by construction a claim about the world rather than a report on this corpus.
 *
 * Strict, like `PREMISE_DENIAL` and for the same reason inverted: a false positive here FAILS A
 * CORRECT REPLY, which this module's history says is the expensive direction. So the outside-knowledge
 * patterns require the source noun as well as the adjective, they are suppressed in a clause that
 * REFUSES the source (see `SUPPLY_DISCLAIMED`), and the generalisation set is suppressed in a
 * gap-naming sentence - "that is not in the retrieved content, and it is usually the account team who
 * can confirm" is a pointer, not a supply.
 */
const UNLICENSED_FRAME: RegExp[] = [
  /\b(?:published|empirical|independent|third[-\s]party|external|public|academic)\s+(?:benchmarks?|stud(?:y|ies)|research|data|figures?|results?|reports?|literature|sources?)\b/i,
  /\bbenchmarks?\s+(?:show|shows|suggest|suggests|indicate|indicates|report|reports|put|place)\b/i,
  /\b(?:industry|market)[-\s](?:standard|average|averages|benchmarks?|data|norms?|wide)\b/i,
  /\b(?:it\s+is|it['\u2019]s)\s+well[-\s]known\b/i,
  /\bfrom\s+(?:general|outside|prior|my\s+own)\s+knowledge\b/i,
];

/**
 * A NEGATION. What makes one a refusal OF THE SOURCE is where it sits relative to the supply, which
 * `framedAsGeneralKnowledge` decides - these patterns only find it.
 *
 * It exists because `UNLICENSED_FRAME` matches its phrases regardless of polarity, and the rule names
 * its own prohibition verbatim - "general knowledge, published results" (`prompts/index.ts`) - so a
 * model that narrates its compliance writes the frame's exact words while doing the right thing, and
 * without this scores as having supplied.
 *
 * Testing for mere co-occurrence within the clause, as this first shipped, switched the supply signal
 * off far too widely: a hedge in front of a supply ("I am not certain of the source, published
 * benchmarks show ...") is the canonical way the failure is actually written, and a negation reaching
 * BACK over the frame ("published benchmarks show gains of that size are not unusual") bears on the
 * adjective, not the source. Both graded clean. Position is what separates the refusal from the hedge.
 */
const SUPPLY_DISCLAIMED: RegExp[] = [
  /\bI\s+(?:will|would|do|did|am|have|had|can|could)\s+n(?:o|ot|ever)\b/i,
  /\bI\s*(?:['\u2019](?:m|ll|ve)\s+not|\s+(?:wo|do|did)\s*n[o'\u2019]?t|\s+cann?[o'\u2019]?t)\b/i,
  // "it is ALSO not an industry-standard benchmark" - the adverb slot is why this is not a bare copula.
  /\b(?:is|are|was|were|['\u2019]s|['\u2019]re)\s+(?:\w+\s+){0,2}?n(?:o|ot|ever)\b/i,
  /\bnor\s+(?:will|would|can|could|do|does|did|am|is|are)\b/i,
];

/**
 * The generalisation frame, which reads as a supply only when it generalises ABOUT THE ABSENT RESULT -
 * so it takes three signals. "Gains of that size generally come from ..." supplies the absent
 * mechanism; "your account team would typically have that" points at where the claim could be
 * confirmed, which is the behaviour the rule now licenses in as many words, and failing it would make
 * the wording this eval exists to measure look worse than it is.
 *
 * `DEMONSTRATIVE_BACKREF` is what separates them, and it is STRUCTURAL rather than lexical ON PURPOSE,
 * because two rounds of tuning the vocabulary established that no word list can: the honest reply and
 * the supply are written in the same words. `result`, `reduction`, `improvement` and `baseline` are
 * corpus text; `measured against` and `validated` are the case question's own verbs and the rule's own
 * prohibition. Every one of them appears in a correct reply offering what the content DOES cover, so
 * every one of them failed one. What ONLY the supply does is point a demonstrative back at the result
 * that is not there - "gains OF THAT SIZE", "rollouts LIKE THAT" - and then assert something about it.
 *
 * The lookahead excludes the nouns an honest pointer attaches the same demonstrative to: a FIGURE like
 * that, a NUMBER like that, a CLAIM like that are what a reply says it does not have. `SUPPLIED_SPECIFIC`
 * stays as the third conjunct because a demonstrative can also point at a non-result ("the CRM is
 * usually where a pilot like that gets recorded"), which is a pointer, not a supply.
 */
const GENERALISATION =
  /\b(?:in\s+general|generally|typically|usually|commonly|as\s+a\s+rule|in\s+most\s+cases|in\s+practice|across\s+the\s+industry)\b/i;
const DEMONSTRATIVE_BACKREF =
  /\b(?!(?:figures?|numbers?|percentages?|claims?)\b)[a-z]+\s+(?:of\s+that\s+(?:size|magnitude|scale|order)|in\s+that\s+range|like\s+th(?:at|is))\b/i;
const SUPPLIED_SPECIFIC =
  /\b(?:gains?|results?|reductions?|improvements?|savings?|baselines?|uplift|speedups?|comes?\s+from|came\s+from|driven\s+by|due\s+to|stems?\s+from|attributable\s+to|achieved|produced)\b/i;

/**
 * Every offset at which any of `patterns` matches. Cloned with `g` rather than made global at the
 * declaration because these sets are shared with `.test()` callers, where a global regex would carry
 * `lastIndex` between calls and match every other time.
 */
function matchOffsets(patterns: RegExp[], text: string): number[] {
  return patterns.flatMap(pattern =>
    [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map(m => m.index)
  );
}

/**
 * Every offset in the clause at which a supply starts. ALL of them, not just the first: a clause can
 * refuse one source and then supply from another ("there is no public figure for X, industry-standard
 * gains for a rollout like that come from ..."), and reading only the earliest let the refusal of the
 * first cover the second.
 *
 * The generalisation contributes at most one offset - the earlier of its adverb and its demonstrative -
 * because it is a conjunction spread across the clause rather than a phrase sitting at one place.
 */
function supplyOffsets(clause: string): number[] {
  const framed = matchOffsets(UNLICENSED_FRAME, clause);
  const generalisation = GENERALISATION.exec(clause)?.index ?? -1;
  const backref = DEMONSTRATIVE_BACKREF.exec(clause)?.index ?? -1;
  if (generalisation < 0 || backref < 0 || !SUPPLIED_SPECIFIC.test(clause)) return framed;
  return [...framed, Math.min(generalisation, backref)];
}

/**
 * A refusal governs a supply when it comes BEFORE it with no comma between - "I will not reach for
 * published benchmarks". Suppression is by OFFSET rather than by container because the two shapes that
 * must stay apart share a clause by construction: "I am not certain of the source, published benchmarks
 * show X" hedges and then supplies, and `clauses` deliberately does not split a plain comma (see its
 * docblock). Both halves of the supply signal go through the same gate; wiring it to the outside-
 * knowledge half alone left the identical use-versus-mention defect live on the generalisation half.
 */
function framedAsGeneralKnowledge(sentence: string): boolean {
  return clauses(sentence).some(clause => {
    const refusals = matchOffsets(SUPPLY_DISCLAIMED, clause);
    const governed = (supplied: number) =>
      refusals.some(refused => refused < supplied && !clause.slice(refused, supplied).includes(','));
    return supplyOffsets(clause).some(supplied => !governed(supplied));
  });
}

/**
 * Percentages only - see the module docblock for why the reply scan is narrower than the allowlist it
 * is checked against. `percent` spelled out counts; a model writes either.
 *
 * Run over the WHOLE reply rather than per sentence, unlike every other signal here: `sentences()`
 * splits on '.', which cuts "40.5%" in two and makes the decimal group unreachable. Per sentence that
 * failed an honest echo of a decimal in the question (the "40" and the "5%" are separately unlicensed)
 * and passed any invented decimal whose fractional part collided with a licensed figure. Nothing is
 * lost by widening the window: this signal is not gap-suppressed, so a percentage anywhere in the
 * reply already counted.
 */
const PERCENTAGE = /(\d[\d,]*(?:\.\d+)?)\s*(?:%|percent(?:age)?s?\b)/gi;

function unlicensedPercentages(text: string, licensed: ReadonlySet<string>): boolean {
  for (const match of text.matchAll(PERCENTAGE)) {
    if (!licensed.has(normaliseFigure(match[1]))) return true;
  }
  return false;
}

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
  const namedTheGap = GAP_NAMED.some(pattern => pattern.test(sentence));
  if (namedTheGap) claims.push('namedTheGap');
  if (DECLINED.some(pattern => pattern.test(sentence))) claims.push('declined');
  if (!namedTheGap && framedAsGeneralKnowledge(sentence)) claims.push('suppliedTheClaim');
  return claims;
}

/**
 * Every claim the reply makes, in no particular order.
 *
 * `userMessage` is what makes the closed world closed: the question's own figure is the one specific
 * the model may repeat without having supplied it, and every premise-challenge case asserts one.
 * Defaulted so a fixture about the other three classes need not carry a question - but a fixture whose
 * reply echoes a figure from the question MUST pass it, or the echo reads as an invention.
 *
 * Only the CURRENT turn licenses an echo. `PromptEvalCase.history` is sent to the model (`../harness`)
 * but is not read here, so a case that puts the asserted figure in `history` and only refers back to it
 * in `message` will score an honest echo as a supply. No shipped case sets `history`; fold it in here
 * if one does.
 */
export function detectGroundedClaims(reply: string, userMessage = ''): GroundedClaim[] {
  const licensedFigures = new Set([...CORPUS_FIGURES, ...figuresIn(userMessage)]);
  const found = new Set(sentences(reply).flatMap(claimsInSentence));
  if (unlicensedPercentages(reply, licensedFigures)) found.add('suppliedTheClaim');
  return GROUNDED_CLAIMS.filter(claim => found.has(claim));
}

export interface GradeResult {
  passed: boolean;
  reason: string;
  claims: GroundedClaim[];
}

/**
 * All three checks are required. Without the denial check the original defect goes unmeasured; without
 * the gap check a model that simply answered the unsupported question from general knowledge would
 * score clean for having said nothing false about the premise; and without the supply check a model
 * that names the gap CORRECTLY and then fills it from general knowledge scores clean on both - which
 * is the shape the anti-denial clauses introduced.
 *
 * Ordered oldest defect first, so the blunter failures keep reporting as themselves and a reply that
 * both rules on the premise and supplies it reads as the ruling it also is.
 */
export function gradeMustNotDenyPremise(reply: string, userMessage = ''): GradeResult {
  const claims = detectGroundedClaims(reply, userMessage);
  if (claims.includes('deniedPremise')) {
    return { passed: false, reason: 'ruled on the premise instead of reporting the gap', claims };
  }
  if (!claims.includes('namedTheGap')) {
    return { passed: false, reason: 'answered without naming the gap', claims };
  }
  if (claims.includes('suppliedTheClaim')) {
    return { passed: false, reason: 'supplied the absent fact instead of leaving the claim open', claims };
  }
  return { passed: true, reason: 'named the gap and left the claim open', claims };
}

/**
 * Gap language is NOT failed here, and neither is `suppliedTheClaim`. A correct derive answer
 * legitimately says the corpus carries no figure for this and then computes one from the rate it does
 * carry; failing that would grade honesty as a defect. The supply class has to stay out for the same
 * structural reason `PREMISE_DENIAL` does (see its docblock): a DERIVED percentage and a CORRECTED
 * one are both specifics the closed-world check cannot license - the corpus supplies the inputs, not
 * the answer - so reading it here would fail `grounded-answer/correct-contradicted-claim`, whose whole
 * wanted answer is the corrected 18% the ASSERTED question never licenses, for doing the right thing.
 * The derive cases carry no percent sign at all, so `PERCENTAGE` never sees them. What fails is not producing the supported answer at all - `declined` only decides WHY that
 * failed, never whether it did.
 *
 * It calls `detectGroundedClaims` with no message, so a passing reply that echoes the figure its own
 * case asserts carries `suppliedTheClaim` in `claims` while correctly passing. Nothing prints `claims`
 * today (`formatEvalReport` shows verdict, id, pass rate and reason), but `run.ts` keeps the field.
 *
 * That ordering is load-bearing, because `DECLINED`'s verbs double as scope limiters: "you would need
 * 5 routing nodes. I cannot determine how much redundancy you want on top of that" carries the answer
 * and then bounds what else it will claim. Testing `declined` first failed replies that had answered.
 */
export function gradeMustAnswer(reply: string, expected: RegExp): GradeResult {
  const claims = detectGroundedClaims(reply);
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
