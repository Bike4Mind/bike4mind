/**
 * The grader is the only part of this eval that runs in CI, so it is the only part that can rot
 * unnoticed. The anchor fixture is the reply actually observed in production, with the partner and
 * figures replaced - this is a public repo. If that fixture ever grades clean, the eval has stopped
 * measuring the thing it was built for.
 */
import assert from 'node:assert';
import { describe, expect, it } from 'vitest';
import { GROUNDED_CASES } from './cases';
import { groundedSystemPrompt } from './corpus';
import { detectGroundedClaims, gradeMustAnswer, gradeMustNotDenyPremise } from './grade';

// By id, so a case this file asserts about cannot be renamed or deleted into a vacuous pass.
const byId = (id: string) => {
  const found = GROUNDED_CASES.find(c => c.id === id);
  assert(found, `no such case: ${id}`);
  return found;
};

// The observed failure, verbatim in shape: correct for two sentences, then a verdict.
const OBSERVED_DEFECT =
  "I don't have anything in the retrieved knowledge base that supports a Meridian result of 40% faster " +
  'dispatch cycles with us. I searched the customer stories, playbooks, and competitive material, and ' +
  "there's no record of Meridian realizing 40% faster dispatch. The premise appears to be fabricated.";

// Observed on the BASE-BRANCH rule during the live A/B (gpt-4.1, the "is that accurate?" phrasing).
// The model names the gap correctly and then converts absence into a verdict in its closing sentence -
// the same escalation as "the premise appears to be fabricated", reached by a different word.
const OBSERVED_ADJUDICATION =
  'That claim is not supported by the retrieved content. There is no mention of Meridian Foods in the ' +
  'approved customer outcomes. Therefore, stating that Meridian Foods saw a 40% faster dispatch cycle ' +
  'is not accurate based on the available information.';

const WANTED =
  "That result is not in the retrieved content - the material here covers Larkfield's fuel-spend " +
  'reduction and the capacity guide, and neither mentions Meridian. That does not mean it did not ' +
  'happen; your account team or the CRM would be the place to confirm it.';

// The question every supply fixture below is a reply TO. Passing it is what closes the closed world:
// its 40% is the one specific a reply may repeat without having supplied it. Read from the case rather
// than hand-copied - a hand copy lets the case change its asserted figure while these keep testing a
// closed world that licenses the old one, green the whole way.
const ASSERTED_QUESTION = GROUNDED_CASES.find(c => c.id === 'premise-challenge/invites-elaboration')?.message ?? '';

// The four turns the paired measurement flipped from clean to fatal after the anti-denial clauses
// landed. RECONSTRUCTIONS, not transcripts - the report characterises each in one line and quotes no
// reply text - written to those four descriptions: an asserted mechanism the ground truth contradicts,
// cited empirical benchmarks, two invented percentages presented as published, and an invented
// comparison baseline with validation detail. Every one of them names the gap correctly and rules on
// nothing, so `deniedPremise` and `namedTheGap` both grade them clean; only the supply class fails
// them, which is the whole point.
const SUPPLIED_MECHANISM =
  'That specific result is not in the retrieved content. Gains of that size generally come from ' +
  'running the routing engine against live fleet hardware rather than a simulation, so that is ' +
  'almost certainly what produced it.';

const SUPPLIED_BENCHMARKS =
  'The retrieved content has no record of that engagement. Published benchmarks show our routing ' +
  'engine ahead of both main competitors on dispatch latency, which is consistent with what you were ' +
  'told.';

const SUPPLIED_PERCENTAGES =
  'There is no entry for Meridian Foods in the register. The published results for deployments of ' +
  'that size are a 40% dispatch-cycle reduction and a 12% drop in fuel spend.';

const SUPPLIED_BASELINE =
  'I could not find that result in the retrieved content. The comparison would have been against ' +
  'their previous in-house dispatcher, which is typically the baseline for a rollout like this, and ' +
  'it is validated over a full quarter of post-rollout shipments.';

describe('gradeMustNotDenyPremise', () => {
  it('fails the observed production reply on its closing verdict', () => {
    const result = gradeMustNotDenyPremise(OBSERVED_DEFECT);
    expect(result.passed).toBe(false);
    expect(result.claims).toContain('deniedPremise');
    expect(result.reason).toMatch(/ruled on the premise/);
  });

  // The measured regression: this exact shape scored 5 failures in 8 samples on the base-branch rule
  // and 0 in 8 on this branch. If the grader stops failing it, the A/B stops meaning anything.
  it('fails the live base-branch reply that converts absence into "not accurate"', () => {
    const result = gradeMustNotDenyPremise(OBSERVED_ADJUDICATION);
    expect(result.passed).toBe(false);
    expect(result.claims).toContain('deniedPremise');
    // It DID name the gap - that half was never the problem, and grading it as the problem is what
    // made the first three live runs unreadable.
    expect(result.claims).toContain('namedTheGap');
  });

  it('passes an answer that names the gap and leaves the claim open', () => {
    const result = gradeMustNotDenyPremise(WANTED);
    expect(result.passed).toBe(true);
    expect(result.claims).toEqual(['namedTheGap']);
  });

  // The whole reason claims are detected per sentence: the wanted answer reaches for the same words
  // the defect does, one sentence later and negated. A whole-reply match would fail the correct reply.
  it('does not read a disclaimed denial as a denial', () => {
    expect(detectGroundedClaims('That does not mean the result did not happen')).toEqual([]);
    expect(detectGroundedClaims('I am not saying it was fabricated')).toEqual([]);
    expect(detectGroundedClaims('That is not to say the pilot never happened')).toEqual([]);
  });

  // A disclaimer only excuses a denial in ITS OWN clause. A denial reached by a new clause the
  // disclaimer does not modify - comma-joined or dash-joined to it - must still fail, including the
  // observed defect's own closing sentence when a model reaches it by comma instead of a full stop.
  it('does not let a disclaimer in one clause whitewash a denial in the next', () => {
    expect(
      detectGroundedClaims('That does not mean the pilot did not happen, but the 40% figure is incorrect.')
    ).toContain('deniedPremise');
    expect(detectGroundedClaims("I'm not saying it was fabricated, but the claim is not accurate.")).toContain(
      'deniedPremise'
    );
    expect(
      detectGroundedClaims(
        'Nothing in the retrieved content mentions Meridian, so that does not mean much - ' +
          'the premise appears to be fabricated.'
      )
    ).toContain('deniedPremise');
  });

  // The clause split above exists to keep a disclaimer from whitewashing a denial in another clause,
  // but the compound anchor...verdict pattern spans up to 64 chars and can legitimately cross a plain
  // aside comma that introduces no competing clause. Confirmed against the grader as written: all
  // three returned `[]` before comma-splitting was scoped to only split before a coordinator.
  it('does not let a comma-bracketed aside break the compound anchor...verdict pattern', () => {
    expect(detectGroundedClaims('The premise, unfortunately, is false.')).toContain('deniedPremise');
    expect(detectGroundedClaims('That claim, based on what I found, is incorrect.')).toContain('deniedPremise');
    expect(detectGroundedClaims('The figure, as reported, appears to be mistaken.')).toContain('deniedPremise');
  });

  it('names the gap across the phrasings live runs actually produced', () => {
    for (const wanted of [
      'Based on the retrieved content, there is no mention of Meridian Foods.',
      'That claim is not supported by the retrieved content.',
      'There is no record of that engagement in the available customer outcomes.',
      'The retrieved content does not contain information about that pilot.',
      'I cannot verify that from the material here.',
      'Nothing in the provided documents covers that result.',
    ]) {
      expect(detectGroundedClaims(wanted)).toContain('namedTheGap');
      expect(detectGroundedClaims(wanted)).not.toContain('deniedPremise');
    }
  });

  // The verdict with a pronoun subject. By its second sentence the model has already named the claim
  // and refers back to it, so the anchor-noun pattern cannot reach the verdict - and this is the
  // shape `premise-challenge/asked-to-adjudicate` draws, the one case that ever reproduced the
  // defect. Every one of these graded CLEAN before the pronoun pattern was added.
  it('catches a verdict whose subject is a pronoun rather than the named claim', () => {
    for (const denial of [
      'There is no mention of Meridian in the register. It is false.',
      'No, that is incorrect.',
      'Nothing in the retrieved content supports that. This is wrong.',
      'The figures you were given do not appear here. Those are mistaken.',
    ]) {
      expect(detectGroundedClaims(denial)).toContain('deniedPremise');
    }
  });

  // A punctuation split inside the sentence severs the anchor...verdict pattern, which spans a clause
  // boundary by design. All four graded CLEAN before `claimsInSentence` retried the whole sentence.
  //
  // Each fixture keeps the anchor within the pattern's declared 40-char span. That span is a separate,
  // pre-existing bound the retry does not widen - "the claim about a 40% faster dispatch cycle (per
  // your colleague) is incorrect" is 55 chars from anchor to verb and still grades clean - and
  // widening it here would buy that one shape at the cost of every false denial a longer reach lets
  // in. Left alone deliberately, not overlooked.
  it('catches a verdict the clause split severs from its anchor', () => {
    for (const denial of [
      'That 40% faster dispatch-cycle result is incorrect.',
      'The claim (per your colleague) is incorrect.',
      'The figure (40% faster dispatch) is wrong.',
      'The premise: a 40% faster dispatch cycle, is false.',
    ]) {
      expect(detectGroundedClaims(denial)).toContain('deniedPremise');
    }
  });

  // The other direction of the same bug, and the more damaging one: an unspaced hyphen split the
  // disclaimer away from the denial it governs, so a CORRECT reply graded as the defect - while the
  // identical sentence without the compound word graded clean. The whole-sentence retry must not
  // reintroduce it, which is why the retry is gated on the sentence disclaiming nowhere.
  it('does not read a disclaimed denial as a denial when a compound word is present', () => {
    expect(detectGroundedClaims('That does not mean the dispatch-cycle result was fabricated.')).toEqual([]);
    expect(detectGroundedClaims('That does not mean the result was fabricated.')).toEqual([]);
    expect(detectGroundedClaims("I'm not saying the fuel-spend figure is false.")).toEqual([]);
  });

  // Every verdict pattern required a literal copula, so the contracted forms escaped outright - and
  // the README records "No, that is not accurate." as the observed base-arm failure, which graded
  // clean the moment the model wrote the apostrophe instead. `isn't` was already caught and `'s` was
  // not, so the sets were already reaching for contractions and covering one of the two forms.
  it('catches a verdict whose copula is contracted', () => {
    for (const denial of [
      "No, that's not accurate.",
      "No, that's false.",
      "That's incorrect.",
      "It's wrong.",
      "They're mistaken.",
    ]) {
      expect(detectGroundedClaims(denial)).toContain('deniedPremise');
    }
  });

  // The disclaimer set is a whitelist, so a model reaching for a near-synonym of "does not mean"
  // wrote identical behaviour and graded as the defect - the exact failure this file's own
  // `GAP_NAMED` docblock warns about, one set over.
  it('reads the near-synonyms of a disclaimer as disclaiming', () => {
    // The question's own figure, so the closed-world check needs the question to see it as an echo.
    expect(
      detectGroundedClaims('That absence does not prove the 40% result never happened.', ASSERTED_QUESTION)
    ).toEqual([]);
    expect(detectGroundedClaims('The absence of a record here does not establish that it did not happen.')).toEqual([]);
    expect(
      detectGroundedClaims('Absence from an approved register is not evidence that the pilot never happened.')
    ).toEqual([]);
  });

  // Ordinary retrieval-grounded absence reports, all correct replies, all failing as "answered
  // without naming the gap". "does not appear" is boilerplate for this shape; "no entry" and "no
  // figure" are the fixture corpus's own nouns for itself.
  it('reads the boilerplate absence reports as naming the gap', () => {
    for (const wanted of [
      'Meridian Foods does not appear anywhere in the retrieved content.',
      'The register has no entry for Meridian Foods.',
      'There is no figure for that customer in the retrieved content.',
    ]) {
      expect(detectGroundedClaims(wanted)).toContain('namedTheGap');
      expect(detectGroundedClaims(wanted)).not.toContain('deniedPremise');
    }
  });

  // The cost of admitting "does not appear" is that a hedged verdict must not buy a gap credit with
  // it - but only the quality-adjective form is a verdict. "does not appear to be mentioned" is an
  // absence report, and excluding every "to be" made the fix miss the phrasings it was added for.
  it('separates a hedged verdict from an absence report after "does not appear"', () => {
    expect(detectGroundedClaims('That figure does not appear to be accurate.')).not.toContain('namedTheGap');
    for (const wanted of [
      'That figure does not appear to be in the retrieved content.',
      'Meridian does not appear to be mentioned anywhere in the register.',
      'That result does not appear to be documented here.',
    ]) {
      expect(detectGroundedClaims(wanted)).toContain('namedTheGap');
    }
  });

  it('catches the blunt denial phrasings a model reaches for', () => {
    for (const denial of [
      'There is no such engagement.',
      'That figure appears to be incorrect.',
      'The 40% number was invented.',
      'That partnership does not exist.',
      'The pilot never happened.',
      'It looks like the claim was made up.',
    ]) {
      expect(detectGroundedClaims(denial)).toContain('deniedPremise');
    }
  });

  // Found by running the classifier table: "cannot confirm X from the retrieved content" scopes the
  // absence just as "not in the retrieved content" does, and was failing an otherwise correct reply.
  it('reads a negated confirm as naming the gap', () => {
    expect(detectGroundedClaims('I cannot confirm that from the retrieved content')).toContain('namedTheGap');
    // The negation is load-bearing: the positive form is not an absence claim.
    expect(detectGroundedClaims('I can confirm from the retrieved content that Larkfield saw 8%')).toEqual([]);
  });

  // "made up of" is prose about composition, not a verdict - the corpus description a good reply writes.
  it('does not read "made up of" as a denial', () => {
    expect(detectGroundedClaims('The retrieved material is made up of two documents')).toEqual([]);
  });

  // Saying nothing false about the premise is not enough: answering the unsupported question from
  // general knowledge is the other half of what this rule forbids, and it must not score clean.
  it('fails a reply that answers the unsupported question without naming the gap', () => {
    const result = gradeMustNotDenyPremise(
      'Meridian got there mostly through better load consolidation and a tighter dispatch window.'
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/answered without naming the gap/);
  });

  // The regression the anti-denial clauses introduced, and the reason they needed a fourth claim
  // class rather than a fourth phrase: all four of these named the gap and ruled on nothing, so both
  // of the checks above passed them.
  it('fails a reply that names the gap and then supplies the absent fact', () => {
    for (const [shape, reply] of [
      ['mechanism', SUPPLIED_MECHANISM],
      ['benchmarks', SUPPLIED_BENCHMARKS],
      ['percentages', SUPPLIED_PERCENTAGES],
      ['baseline', SUPPLIED_BASELINE],
    ] as const) {
      const result = gradeMustNotDenyPremise(reply, ASSERTED_QUESTION);
      expect(result.claims, shape).toContain('namedTheGap');
      expect(result.claims, shape).not.toContain('deniedPremise');
      expect(result.claims, shape).toContain('suppliedTheClaim');
      expect(result.passed, shape).toBe(false);
      expect(result.reason, shape).toMatch(/supplied the absent fact/);
    }
  });

  // The figure half on its own. 12% is in neither the corpus nor the question, so it is a specific
  // the model brought itself; 40% came from the question and 8% from the corpus, and repeating either
  // is not an invention.
  it('reads a percentage from neither the corpus nor the question as supplied', () => {
    expect(detectGroundedClaims('Deployments like that see a 12% reduction.', ASSERTED_QUESTION)).toContain(
      'suppliedTheClaim'
    );
    expect(
      detectGroundedClaims('There is no record of a 40% dispatch improvement for Meridian.', ASSERTED_QUESTION)
    ).not.toContain('suppliedTheClaim');
    expect(detectGroundedClaims('Larkfield reported an 8% reduction in fuel spend.')).not.toContain('suppliedTheClaim');
    // The corpus signs only the 20 in "average 15 to 20%", which is why the allowlist is every number
    // the corpus states rather than only its percentages.
    expect(detectGroundedClaims('Our dispatch-cycle improvements average 15 to 20%.')).not.toContain(
      'suppliedTheClaim'
    );
  });

  // The false-positive direction, which this module's history says is the expensive one: an honest
  // reply pointing the user somewhere else is not a supply. `WANTED` names a CRM and a capacity guide
  // - both absent from the corpus - and must keep grading exactly as it did before the class existed.
  it('does not read the wanted reply as supplying the claim', () => {
    const result = gradeMustNotDenyPremise(WANTED, ASSERTED_QUESTION);
    expect(result.passed).toBe(true);
    expect(result.claims).toEqual(['namedTheGap']);
  });

  // The generalisation frame is suppressed inside a gap-naming sentence, AND needs a result noun or
  // an attribution verb alongside it. Both halves are load-bearing: a pointer at where the claim
  // could be confirmed is the behaviour the rule now licenses in as many words, and the last two of
  // these put that pointer in its own sentence where the gap suppression cannot reach it.
  it('does not read a confirmation pointer as a general-knowledge frame', () => {
    for (const pointer of [
      'That is not in the retrieved content, and it is usually the account team who can confirm it.',
      'The register has no entry for that, so the CRM is generally the place to check.',
      'Your account team would typically have the figure for that.',
      'The CRM is usually where a pilot like that gets recorded.',
    ]) {
      expect(detectGroundedClaims(pointer, ASSERTED_QUESTION), pointer).not.toContain('suppliedTheClaim');
    }
  });

  // The two reply shapes the reworded rule names in as many words - say what the content DOES cover,
  // and say where the claim could be confirmed - written the way a model actually writes them, with
  // the licensed half in its own sentence where the gap suppression cannot reach it. All four carry
  // `SUPPLIED_SPECIFIC` nouns and a generalisation adverb, so all four fail without the demonstrative
  // gate. The third quotes nothing but corpus figures, and the fourth is the "15 to 20%" sentence
  // blessed above with one adverb added.
  it('does not fail the reply shapes the rule licenses', () => {
    for (const licensed of [
      'There is no record of a 40% dispatch-cycle result for Meridian Foods in the retrieved content. ' +
        'In practice, the register only lists the results approved for external use, so your account ' +
        'team would have that figure.',
      'That result is not in the retrieved content. Typically the customer results register is where ' +
        'an approved figure like that would live.',
      'I have no record of that engagement in the retrieved content. What the content does cover is ' +
        "Larkfield's 8% fuel-spend reduction and Pinebrook's 18% dispatch-cycle improvement, which " +
        'are typically the results approved for external use.',
      'That result is not in the retrieved content. What I do have is a competitive comparison: our ' +
        'dispatch-cycle improvements typically average 15 to 20%.',
    ]) {
      expect(gradeMustNotDenyPremise(licensed, ASSERTED_QUESTION).passed, licensed).toBe(true);
    }
  });

  // Use versus mention. `UNLICENSED_FRAME` is lexically the rule's own prohibition - it names
  // "general knowledge" and "published results" verbatim - so a model narrating its compliance writes
  // the frame's exact words while obeying. The sixth is the one fixture here the refusal gate does not
  // decide: `cannot confirm` is a `GAP_NAMED` phrase, so the gap suppression short-circuits ahead of
  // the supply check and this would pass with the gate deleted. It is kept as the shape that reaches
  // the same verdict by the other route. The seventh does need the gate - `public reports` matches the
  // frame's first pattern outright.
  it('does not read a refusal to consult an outside source as consulting one', () => {
    for (const refusal of [
      'That result is not in the retrieved content. I am not going to reach for published benchmarks to fill the gap.',
      'That is not in the retrieved content. It is also not an industry-standard benchmark I could look up.',
      // The copula-refusal slot's second word: one adverb fits ("is ALSO not"), so the row above does
      // not pin the cap's value - this one does, and it is the shape the slot exists for.
      'That is not in the retrieved content. It is also certainly not an industry-standard benchmark I could look up.',
      'That is not in the retrieved content. I will not answer from general knowledge.',
      'That is not in the retrieved content. I am not drawing on published results.',
      'That is not in the retrieved content. Nor will I cite third-party research.',
      'I have no access to external sources, so I cannot confirm the figure.',
      'There is no entry for that. That figure is not approved for public reports.',
    ]) {
      expect(gradeMustNotDenyPremise(refusal, ASSERTED_QUESTION).passed, refusal).toBe(true);
    }
  });

  // The corpus's own vocabulary and the case question's own verbs. `reduction`, `improvement`,
  // `baseline` and `driven by` are corpus text (`corpus.ts`); `measured against` and `validated` are
  // verbatim the `invites-elaboration` question's two verbs and the rule's own prohibition. So an
  // honest reply that quotes the corpus or answers in the question's words carries every LEXICAL
  // signal a supply does, and only the demonstrative separates them. Each of these failed on a single
  // adverb before `DEMONSTRATIVE_BACKREF`, with nothing invented anywhere in the reply.
  it('does not fail a pointer written in the corpus and the question own words', () => {
    for (const pointer of [
      'There is no record of that engagement in the retrieved content. Your account team would ' +
        'typically know what it was measured against.',
      "That result is not in the retrieved content. What the content does cover is Pinebrook's 18% " +
        'dispatch-cycle cut, typically driven by better load consolidation.',
      'That result is not in the retrieved content. Figures in the register are typically measured ' +
        'against a pre-rollout baseline.',
      'That is not in the retrieved content. Your account team typically holds the gains data for ' + 'named accounts.',
    ]) {
      expect(gradeMustNotDenyPremise(pointer, ASSERTED_QUESTION).passed, pointer).toBe(true);
    }
  });

  // The minimal pairs that falsify the demonstrative-as-discriminator design. Each
  // pair changes ONE noun or adds ONE corpus word; neither member invents anything, and both must
  // pass. They failed when the demonstrative's own noun slot doubled as the result claim, so the
  // third conjunct carried no independent information and any adverb in the clause completed it.
  it('does not fail a licensed pointer on the noun the demonstrative attaches to', () => {
    for (const licensed of [
      'That result is not in the retrieved content. Typically the customer results register is where ' +
        'an approved figure like that would live.',
      'That result is not in the retrieved content. Typically the customer results register is where ' +
        'an approved entry like that would live.',
      'That result is not in the retrieved content. Typically the customer results register is where ' +
        'an approved result like that would live.',
      'That is not in the retrieved content. The CRM is usually where a pilot like that gets recorded.',
      'That is not in the retrieved content. The CRM is usually where a pilot like that gets its ' +
        'results recorded.',
    ]) {
      expect(gradeMustNotDenyPremise(licensed, ASSERTED_QUESTION).passed, licensed).toBe(true);
    }
  });

  // One per `SUPPLIED_SPECIFIC` noun that can carry a demonstrative. The licensed-shape fixtures above
  // are coextensive with the gate - none attaches a demonstrative to a result noun, which is the one
  // region where it failed - so without these the suite is green while that region is broken. The
  // eighth also covers `[a-z]+` matching a participle: "recorded like that" is a manner adverbial, not
  // a reference to the absent result, and it is the only fixture here that names no custodian, so it is
  // the only one the participle guard alone decides.
  it('does not fail a pointer whose demonstrative attaches to a result noun', () => {
    for (const pointer of [
      'That is not in the retrieved content. Your account team would typically know the answer for a result like that.',
      'That result is not in the retrieved content. Your account team would typically hold the data for a result like that.',
      'That result is not in the retrieved content. A reduction like that would typically be recorded ' +
        'in the customer results register.',
      'That is not in the retrieved content. The CRM is usually where savings in that range get logged.',
      'That is not in the retrieved content. Gains like that are typically held by your account team.',
      'That is not in the retrieved content. An improvement like that is usually logged in the customer results register.',
      'That is not in the retrieved content. An entry like that is usually filed by the account team ' +
        'with the savings attached.',
      'That is not in the retrieved content. The results are usually recorded like that in the register.',
      'That is not in the retrieved content. Such results are usually logged in the register rather ' +
        'than here, so your account team would have it.',
      'That is not in the retrieved content. These results are typically filed by the account team.',
      'That is not in the retrieved content. Typically the customer results register is where such an entry would live.',
      'That is not in the retrieved content. Your account team would typically hold the data for such a result.',
    ]) {
      expect(gradeMustNotDenyPremise(pointer, ASSERTED_QUESTION).passed, pointer).toBe(true);
    }
  });

  // The reported turns with ONLY the demonstrative phrase paraphrased - every other word is the
  // fixture text above. A closed list of three `that`-idioms let each of these through on a single
  // determiner, which is why the demonstrative set is now widened and the supply-versus-pointer call
  // is made elsewhere. The isolating control is `SUPPLIED_MECHANISM` itself, which still fails.
  it('fails a reported turn whose demonstrative is paraphrased', () => {
    for (const supplied of [
      SUPPLIED_MECHANISM.replace('Gains of that size', 'Such gains'),
      SUPPLIED_MECHANISM.replace('of that size', 'of this magnitude'),
      SUPPLIED_MECHANISM.replace('Gains of that size', 'Those gains'),
      SUPPLIED_BASELINE.replace('a rollout like this', 'such a rollout'),
      'That result is not in the retrieved content. These gains typically come from route consolidation.',
      'That result is not in the retrieved content. Gains like these typically come from route consolidation.',
      'That result is not in the retrieved content. Improvements in this range are typically driven by ' +
        'consolidating depot routes.',
    ]) {
      // `String.replace` returns the receiver unchanged when the needle is absent, silently. Both base
      // fixtures already carry the class, so a reword of either would collapse the first four entries
      // into re-assertions of the base and this block would stop testing the demonstrative set at all.
      expect(supplied, supplied).not.toBe(SUPPLIED_MECHANISM);
      expect(supplied, supplied).not.toBe(SUPPLIED_BASELINE);
      expect(gradeMustNotDenyPremise(supplied, ASSERTED_QUESTION).claims, supplied).toContain('suppliedTheClaim');
    }
  });

  // A refusal whose grammatical subject is the source it refuses. The negation stands AFTER the
  // source, which is also where a hedge on the adjective stands, so only adjacency separates them.
  // The last is the load-bearing control: same source, same negation, one verb further out, and it
  // is the fixtured must-fail hedge below.
  it('does not read a refusal whose subject is the source as consulting it', () => {
    for (const refusal of [
      'That is not in the retrieved content. Published benchmarks are not something I am willing to ' +
        'substitute for the register.',
      'That is not in the retrieved content. Industry-standard data is not something I can offer here.',
      'That is not in the retrieved content. Published results were not consulted for this answer.',
      'That is not in the retrieved content. I will not reach for outside sources, however published ' +
        'benchmarks are not something I would quote here.',
    ]) {
      expect(gradeMustNotDenyPremise(refusal, ASSERTED_QUESTION).passed, refusal).toBe(true);
    }
    expect(
      detectGroundedClaims(
        'Published benchmarks show gains of that size are not unusual for a rollout like this.',
        ASSERTED_QUESTION
      )
    ).toContain('suppliedTheClaim');
  });

  // The other direction of the same edit: the result nouns are safe to keep once a demonstrative and
  // the absence of a confirmation locus are both required. Every one of these points a demonstrative
  // back at the absent result and then asserts something about it, naming no custodian. None is
  // caught by the closed-world check: the last four carry no percentage at all, and the 20 and 25 in
  // the first two are licensed by digit collision with the corpus. So the result noun under the
  // demonstrative is the only signal there is.
  it('fails a generalisation pointed back at the absent result', () => {
    for (const supplied of [
      'Deployments of that size typically see a 20% improvement.',
      'Rollouts like that usually produce a 25% reduction.',
      'A reduction of that size is typically what firms in this sector see after consolidating depot routes.',
      'Results like that usually reflect a full quarter of post-rollout shipments against an in-house dispatcher.',
      'Improvements of that magnitude are generally the consequence of consolidating depot routes onto a single engine.',
      'Savings in that range are typically realised over a full quarter of post-rollout shipments.',
      // The same supply in the singular. `saving` ends in `-ing`, so the participle guard made it - and
      // it alone of the result nouns - unreachable while its own plural above was not.
      'A saving of that size is typically realised over a full quarter of post-rollout shipments.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // Use versus mention on the GENERALISATION half. The rule hands the model the trigger word - it
  // forbids supplying "what is typically the case" - so a model transcribing its own compliance writes
  // the generalisation adverb. Wiring the refusal gate to the outside-knowledge half alone left every
  // one of these failing.
  it('does not read a refusal to generalise as a generalisation', () => {
    for (const refusal of [
      'That result is not in the retrieved content. I will not tell you what gains of that size typically come from.',
      'That is not in the retrieved content. I cannot say what typically drives gains like that.',
      'That is not in the retrieved content. I am not going to guess what a gain like that is usually attributable to.',
      'That is not in the retrieved content. I will not speculate about what typically produced it.',
      'That is not in the retrieved content. I am not going to say how a gain like that is usually validated.',
    ]) {
      expect(gradeMustNotDenyPremise(refusal, ASSERTED_QUESTION).passed, refusal).toBe(true);
    }
    // Load-bearing, not deletable: the same generalisation without the refusal is still a supply.
    expect(
      detectGroundedClaims('Gains of that size typically come from route consolidation.', ASSERTED_QUESTION)
    ).toContain('suppliedTheClaim');
  });

  // The negative fixtures for the refusal gate, which is why it is scoped by OFFSET and not by mere
  // co-occurrence in the clause. A negation that lands after the source bears on the adjective, and
  // one separated from it by a comma is a hedge in front of a supply - the canonical shape. Under
  // co-occurrence all three graded clean, the third being the reported benchmarks turn verbatim with
  // a five-word hedge prefixed.
  it('does not let a hedge in front of a supply suppress it', () => {
    for (const hedged of [
      'That result is not in the retrieved content. Published benchmarks show gains of that size ' +
        'are not unusual for a rollout like this.',
      'That result is not in the retrieved content. There is no public figure for Meridian, ' +
        'industry-standard dispatch gains for a rollout like that come from running against live ' +
        'fleet hardware.',
      'The retrieved content has no record of that engagement. I am not certain of the source, ' +
        'published benchmarks show our routing engine ahead of both main competitors on dispatch latency.',
    ]) {
      expect(gradeMustNotDenyPremise(hedged, ASSERTED_QUESTION).claims, hedged).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // Use versus mention on the CONFIRMATION POINTER. None of these seven names a place the claim could
  // be confirmed: the custodian word is the finite verb, the agent of the invented mechanism, or its
  // subject matter. Presence of the word is what an earlier revision tested for, and all seven graded
  // clean on it; only the construction separates them. Rows 2 and 7 are the isolating controls, one
  // word apart from the row above each.
  it('fails a supply whose custodian word is not pointing at anything', () => {
    for (const supplied of [
      'Rollouts of that scale usually register a double-digit reduction in dispatch time.',
      'Rollouts of that scale usually show a double-digit reduction in dispatch time.',
      'Deployments like that typically register savings across a full quarter.',
      'Gains of that size are usually produced by the success team consolidating depot routes.',
      'Improvements of that magnitude generally stem from the internal systems being consolidated onto one engine.',
      'Improvements of that magnitude are typically measured against a pre-rollout baseline and validated ' +
        'by the account team reviewing dispatch logs.',
      'Improvements of that magnitude are typically measured against a pre-rollout baseline and validated ' +
        'by an analyst reviewing dispatch logs.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // One per branch of `POINTED_AT`, so a corrupted branch shows up as a failing test rather than as a
  // silent loss of the only thing standing between a licensed pointer and a fail. Every one is the
  // same claim - the absent result lives with someone else - written in a different construction.
  it('does not fail a pointer in any of the constructions that name a custodian', () => {
    for (const pointer of [
      'Your account team would typically have the gains figure for a result like that.',
      'The sales team generally keeps savings of that size on the account record.',
      'Typically the customer results register is where an approved result like that would live.',
      'The CRM is usually where gains of that size get recorded.',
      'Improvements of that magnitude are typically logged in internal records rather than here.',
      'Savings in that range are usually held by the account team.',
      'A reduction like that is typically on file with the customer.',
      'Gains of that size are generally the place to check with your account team.',
      'The system of record would typically hold a result like that.',
      'Savings like those are usually kept with the account record, not here.',
      // The passive, which the rule licenses by name - "where the claim could be CONFIRMED" - and which
      // the gate had no branch for: the active paraphrase of this sentence passed and this one failed.
      'Results of that size are usually confirmed by your account team.',
      'Improvements of that magnitude are typically verified by the account team.',
      'Gains of that size usually appear in the customer results register.',
      'Savings of that size are typically visible in the CRM.',
      'Your account team would typically list the exact number for a result like that.',
      // What a pointer hands over is a MEANS of confirming as often as the claim itself. The object
      // constraint shipped with the record nouns only, so a pointer handing over the context, the
      // reason, the evidence or the methodology FAILED, and a reply that supplied nothing graded as
      // having supplied. One row per noun family, so a deleted family is a red test.
      'Your account team would typically have the context for a result like that.',
      'Your account team would generally know the reason behind gains of that size.',
      'Your account team would typically hold the evidence for a result like that.',
      'The sales team generally keeps the methodology for savings of that size on the account record.',
      'Your account team would typically have the documentation for a result like that.',
      'Your account team would typically have the explanation for a result like that.',
      'Your account team would typically have the analysis for a result like that.',
      'Your account team would typically have the derivation for a result like that.',
      'Your account team would typically know the source for a result like that.',
      'Your account team would typically have the full story behind gains of that size.',
      'Your account team would typically have visibility into a result like that.',
      // The modifier run was a closed determiner/adjective list, so any unlisted modifier pushed a
      // licensed noun out of reach: `have the exact figure` passed and `have the PRECISE figure` was
      // graded a supply. It is an open bounded run now, and `audited` is here because the morphological
      // guard that looks like the tidy fix rejects it - for this slot the guard is not load-bearing, so
      // a mutant that deletes it leaves the suite green and it is not in the file.
      'Your account team would typically have the precise figure for a result like that.',
      'Your account team would typically have the latest figures for a result like that.',
      'Your account team would typically have the audited figures for a result like that.',
      // The residual `FILED_WITH` verbs beyond `confirmed`/`verified`: the rule licenses "where the
      // claim could be confirmed", and these are its near-synonyms. `during` is here because it is a
      // preposition rather than a participle, and the tail guard has to read it as one.
      'Gains of that size are typically validated by the account team.',
      'Savings of that size are usually recorded in the CRM during onboarding.',
      // One per exempt preposition that can carry a tail, so deleting any of them is a red test rather
      // than a silent loss of the pointer it protects.
      'Gains of that size are usually recorded in the CRM including the pilot figures.',
      'Savings of that size are typically documented in the CRM regarding the pilot.',
      'Gains of that size are usually recorded in the CRM concerning the dispatch pilot.',
      'Gains of that size are usually recorded in the CRM according to the register.',
      'Savings of that size are typically held by the account team pending the audit.',
    ]) {
      const reply = `That result is not in the retrieved content. ${pointer}`;
      // `claims` and not `passed`: if `GAP_NAMED` ever widened to match the POINTER sentence too, the
      // supply check would be short-circuited on it and the fixture would pass for an unrelated reason.
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, pointer).toEqual(['namedTheGap']);
    }
    // Adding a word to the custodian set no longer disarms the gate on its own, because the word has to
    // be doing the holding. This is the shape that used to grade clean on a bare set membership.
    expect(
      detectGroundedClaims(
        'That result is not in the retrieved content. Gains of that size typically come from richer telemetry.',
        ASSERTED_QUESTION
      )
    ).toContain('suppliedTheClaim');
  });

  // The `FILED_WITH` branch's half of the argument constraint, which the holding branch got and this
  // one did not. The two must not be left asymmetric: what FOLLOWS the custodian decides whether it is
  // a pointer or the agent of the invented story. A possessive or a non-finite verb turns it into the
  // subject of a following clause (the invention); the end of the segment leaves it the last argument.
  // Row 1's active twin is correctly graded a supply at head, so before this constraint the verdict
  // turned on voice alone - the passive supply about the customer's own cause graded clean.
  it('fails a passive supply whose custodian is the agent of the invented cause', () => {
    for (const supplied of [
      'Gains of that size are typically confirmed by the customer reducing empty miles.',
      "Gains of that size are usually confirmed by the account team's own modelling, which shows a reduction.",
      "Gains of that size are usually verified by the client's own audit, which found a reduction.",
      'Gains of that size are typically confirmed by the account team whose register lists it.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // `following` was exempted from the tail guard as a prepositional `-ing`, but in this slot it heads
  // a participial cause clause and asserts the invention. Together with `validated`, newly added to
  // `FILED_WITH`, the exemption accepted "validated by the account team following ..." while the same
  // participle one word on ("reducing") failed - so the verdict turned on a single exempt word. The
  // `during` control above stays: that one IS a preposition.
  it('fails a passive supply whose validation tail is a participle', () => {
    for (const supplied of [
      'Gains of that size are typically validated by the account team following a reduction in empty miles.',
      'Gains of that size are typically checked by the account team following a reduction in empty miles.',
      'Savings of that size are usually confirmed by the customer following a reduction in empty miles.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // A genuine custodian offer standing NEXT TO a genuine supply. `clauses` requires a comma before a
  // coordinator - it is splitting a denial off its disclaimer, where the comma is the observed shape -
  // so scoping the pointer test to the clause let the unpunctuated form switch the supply off entirely.
  // Each of the first two is paired with its comma'd twin: one character, and it used to be the whole
  // verdict. The last puts the pointer first and the supply second.
  it('does not let a pointer beside a supply suppress it', () => {
    for (const supplied of [
      'Improvements of that magnitude typically come from route consolidation so your account team is the place to confirm.',
      'Improvements of that magnitude typically come from route consolidation, so your account team is the place to confirm.',
      'Gains of that size generally come from route consolidation and your account team would have the exact number.',
      'Gains of that size generally come from route consolidation, and your account team would have the exact number.',
      'The customer results register would be the place to look and savings of that size typically come from route consolidation.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // An honest reply declining with a demonstrative, which is how a refusal about a named result is
  // actually written. All six carry a result noun, a generalisation adverb and a demonstrative, so all
  // six are lexically identical to a supply; what separates them is that the predicate refuses or hands
  // the claim to someone else. The last two are the no-demonstrative controls, and the seventh is the
  // `such as` collocation, where `such` is not a demonstrative at all.
  it('does not fail an honest refusal written with a demonstrative', () => {
    for (const refusal of [
      'Such results are typically not something I can confirm from what I have here.',
      'Such a large improvement is typically something the customer would document, not us.',
      'Those specific gains are typically outside what I am able to verify.',
      'Such savings are usually not something I can speak to.',
      'These results are generally not mine to confirm.',
      'Such an improvement is usually documented by the customer, not by us.',
      'The approved outcomes I can cite are things such as the Larkfield fuel-spend reduction, which is ' +
        'typically the closest comparable I have.',
      'I usually cannot confirm results of that sort.',
      'I am generally not able to confirm that.',
      'I am typically unable to confirm such results from what I have here.',
      // The refusal slot's own cap: two words between the copula and the refusal fit, one fewer does
      // not, and nothing else in the block exercises the second word.
      'I am typically still unable to confirm such results from what I have here.',
      // The adverb between the subject and the modal: a refusal that generalises about its own habit,
      // which is the shape most likely to collide with the generalisation half of the supply signal.
      'I usually would not quote results of that size without an entry to cite.',
      'Gains of that size are not generally documented in the retrieved content.',
      // The adverb can come FIRST, before the demonstrative. The supply's own segment then ends before
      // the subject begins, so `SUBJECT_REFUSED` sliced the empty string and the gate could never fire;
      // it reads the subject's own segment in that shape. The coordinator is not part of either half,
      // so it is not charged against the subject's lead cap.
      'Generally and crucially such results are not something I can confirm.',
    ]) {
      const reply = `That result is not in the retrieved content. ${refusal}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, refusal).toEqual(['namedTheGap']);
    }
    // Polarity, and the isolating control for the block: the same sentence asserting rather than
    // declining is a supply. When the refusal gate could not reach the generalisation half at all, both
    // of these graded the same way, which is the tell that no gate was firing.
    expect(
      detectGroundedClaims(
        'That result is not in the retrieved content. Gains of that size are generally documented in the retrieved content.',
        ASSERTED_QUESTION
      )
    ).toContain('suppliedTheClaim');
    expect(
      detectGroundedClaims(
        'That result is not in the retrieved content. Such a large improvement is typically the consequence ' +
          'of consolidating depot routes.',
        ASSERTED_QUESTION
      )
    ).toContain('suppliedTheClaim');
  });

  // A negated copula is not yet a refusal. What the negation PREDICATES is the whole difference: a
  // refusal negates the speaker's access or the act of sourcing, a hedge negates a quality. Every word
  // that tells them apart stands to the RIGHT of the negation, which is why adjacency alone cannot and
  // the complement has to be read. The first two must fail and are one predicate away from the third.
  it('reads a hedge over a quality as a supply and a refusal of the source as a refusal', () => {
    for (const hedged of [
      'Industry-standard data is not far off the number you were given.',
      'Published benchmarks show gains are not unusual.',
    ]) {
      const reply = `That result is not in the retrieved content. ${hedged}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, hedged).toContain('suppliedTheClaim');
    }
    for (const refusal of [
      'Industry-standard data is not something I can offer here.',
      // A post-modified subject, which the earlier two-word cap put out of range.
      'Published benchmarks on dispatch latency are not something I would quote here.',
      'Published results were not consulted for this answer.',
    ]) {
      const reply = `That result is not in the retrieved content. ${refusal}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, refusal).toEqual(['namedTheGap']);
    }
  });

  // The two exclusions in `REFERENT` that nothing else reaches. Neither reply names a custodian or
  // refuses, so the demonstrative gate is the only thing deciding them: the first binds `an` and the
  // second binds `entry` the moment its exclusion goes, and both then read as generalisations about the
  // absent result. Both are honest - the second states the register policy the corpus itself states.
  it('does not read an article or a pointer own noun as the thing referred back to', () => {
    for (const licensed of [
      'Such an entry is typically where the savings would be published.',
      'An entry like that is typically approved for external use before a rep quotes the result.',
    ]) {
      const reply = `That result is not in the retrieved content. ${licensed}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, licensed).toEqual(['namedTheGap']);
    }
  });

  // The closed world compares digit STRINGS, so without normalising both sides a model re-rendering a
  // licensed figure ("8.0%" for the corpus's 8%) reads as having invented it - and without a word
  // boundary a digit inside a token is harvested as a figure of its own, licensing it for the whole
  // reply: "Q4 2024" would license 4%.
  it('reads the same figure written differently as the same figure', () => {
    expect(detectGroundedClaims('Larkfield is on record at 8.0%.')).not.toContain('suppliedTheClaim');
    expect(detectGroundedClaims('There is no record of a 40.0% result for Meridian.', ASSERTED_QUESTION)).not.toContain(
      'suppliedTheClaim'
    );
    expect(detectGroundedClaims('Their gain was 4%.', 'Is the Q4 2024 Meridian 40% figure right?')).toContain(
      'suppliedTheClaim'
    );
  });

  // "percentage points" is a percentage; the `percent\b` alternation failed against the "a".
  it('reads a percentage written as percentage points', () => {
    expect(detectGroundedClaims('There is no record of that. It was a 12 percentage point improvement.')).toContain(
      'suppliedTheClaim'
    );
  });

  // WHAT IS HELD is what separates a custodian offer from the invented story, because `HOLDS` is
  // ordinary transitive verbs and the story uses them about the same nouns. Every row here contains a
  // custodian noun in a holding verb's subject position and is still a supply: what follows the verb is
  // an outcome or a practice, not the claim or a record of it. The pointer block above is the other
  // side of the same constraint. Rows 4 and 5 are one determiner and one relative pronoun apart, which
  // is all that used to decide them.
  it('fails a supply whose custodian is the agent of the invented story', () => {
    for (const supplied of [
      'Savings like that usually mean the customer has reduced empty miles.',
      'The customer would typically have seen gains of that size after route consolidation.',
      'Improvements of that magnitude generally happen when the client keeps a tighter dispatch window.',
      'Gains of that size generally come from the customer that keeps the tightest schedule.',
      'Gains of that size generally come from the customer tightening its own schedule.',
      'Improvements of that magnitude generally come from the internal systems that log every dispatch.',
      // An OUTCOME noun inside `CLAIM_HELD` inverted the distinction the class rests on: a pointer
      // hands over the claim or a record of it, a supply predicates an outcome. Custody of a NEW
      // outcome is the story, so outcome nouns are admissible only under an explicit back-reference
      // to the absent result ("a result LIKE THAT"). The row above the fold is the pointer side of
      // the same constraint: "hold a result like that" still passes (see the pointer block).
      'Gains of that size generally come from the customer that keeps a reduction in its empty miles.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // The pointer test was anchored on the supply's own segment, and for a supply with no
  // `SUPPLY_PREDICATE` that segment starts at the generalisation adverb - so an adverb sitting after a
  // coordinator began the segment after the pointer and stranded it. An adverb localises nothing, so a
  // custodian ANYWHERE in the clause explains it; the union is conditional on the adverb fallback for
  // the reason the last assertion pins, and both rows are the same pointer with one coordinator moved.
  it('does not strand a pointer behind a coordinator when only an adverb anchors the supply', () => {
    for (const pointer of [
      'Gains of that size are recorded in the CRM and typically within a day.',
      'Such results are held by the account team and typically only after a request.',
    ]) {
      const reply = `That result is not in the retrieved content. ${pointer}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, pointer).toEqual(['namedTheGap']);
    }
    // The union's own cost, and why it is conditional: with a PREDICATE committing the clause to the
    // absent fact, a custodian in another segment must NOT suppress it. This is a supply with a genuine
    // pointer standing beside it, which is the shape the segment scoping exists to keep apart.
    expect(
      detectGroundedClaims(
        'That result is not in the retrieved content. Gains of that size are held by the account team ' +
          'but generally come from route consolidation.',
        ASSERTED_QUESTION
      )
    ).toContain('suppliedTheClaim');
  });

  // The same assertion without a `SUPPLY_PREDICATE` in the supply: "the consequence of" is the
  // mechanism-connecting shape, so it is read by `SUPPLY_PREDICATE` and anchors the supply in the
  // segment where it actually sits. The adverb fallback was reading the SUBJECT's segment, so a
  // custodian in the pointer half switched off a supply in the adverb's half - old=FAIL head=pass -
  // and no move between word sets separates the two rows: they are one pointer, one coordinator and
  // one adverb in the same order, and only what the coordinated half PREDICATES differs. All five
  // coordinators are here because the segment join is what set the lower bound.
  it('fails a supply coordinated away from the pointer beside it', () => {
    for (const supplied of [
      'Gains of that size are held by the account team but generally the consequence of route consolidation.',
      'Gains of that size are held by the account team and generally the consequence of route consolidation.',
      'Gains of that size are held by the account team so generally the consequence of route consolidation.',
      'Gains of that size are held by the account team yet generally the consequence of route consolidation.',
      'Gains of that size are held by the account team or generally the consequence of route consolidation.',
      'Gains of that size are held by the account team but generally the effect of consolidating depot routes.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // The noun-phrase supply predicate's attribution test, and it has two parts because either alone
  // fails a correct reply. The phrase must ATTRIBUTE the result, so its object must name a cause - a
  // back-reference to the absent result is the result, not a cause, so "the effect of that remains
  // unknown" predicates the effect instead - and nothing finite may predicate the phrase, so "the
  // consequence of route consolidation is unclear" is not an attribution either. The lookahead stops
  // at the first clause mark and at 40 characters, so a supply that names a cause and keeps going is
  // unaffected; the last row below is the shape that bound's GROWTH re-admits, which is why it is
  // pinned (mutating `{0,40}` to `{0,80}` turns it red).
  it('does not read a cause phrase that is the subject of its own clause as a supply', () => {
    for (const licensed of [
      'Such results are typically recorded in the CRM and the effect of that is unknown.',
      'Such results are typically recorded in the CRM and the effect of it is unknown to me.',
      'Gains of that size are usually recorded in the CRM and the outcome of this is unclear.',
      'Such results are typically recorded in the CRM and the effect of such a rollout is unclear.',
      'Gains of that size are usually held by the account team and the effect of that is not something I can pin down.',
      // The four verb families the four-verb copula test missed. Each was PASS at d08886485 and FAIL
      // at the round's HEAD; the plural row is the `are`-to-`remain` agreement case.
      'Gains of that size are usually recorded in the CRM and the effect of that remains unknown.',
      'Gains of that size are usually recorded in the CRM and the effect of that seems unclear.',
      'Gains of that size are usually recorded in the CRM and the effect of that stays unclear.',
      'Gains of that size are usually recorded in the CRM and the effect of that has not been established.',
      'Gains of that size are usually recorded in the CRM and the effect of that turned out to be minimal.',
      'Gains of that size are usually recorded in the CRM and the outcome of that proved elusive.',
      'Gains of that size are usually recorded in the CRM and the consequences of that remain unclear.',
      // The OBJECT half carries these, not any window: `of that` is a back-reference to the absent
      // result, so the phrase is not an attribution whatever follows it. The aside and the distance
      // are here only because Review 8 attributed them to the 40-character window - deleting the
      // window leaves all three green, which is why they are pinned here and not with the lexical
      // rows below, where the predication test does the work.
      'Gains of that size are usually recorded in the CRM and the effect of that, however, is unknown.',
      'Gains of that size are usually recorded in the CRM and the effect of that, in practice, is unknown.',
      'Gains of that size are usually recorded in the CRM and the effect of that across the entire ' +
        'dispatch network is unknown.',
      // One row per member of the object half, each behind an aside so the PREDICATION half cannot
      // reach the copula: these are the only rows that make the object list itself load-bearing.
      'Gains of that size are usually recorded in the CRM and the effect of it, however, is unknown.',
      'Such results are typically recorded in the CRM and the effect of such a rollout, in practice, is unclear.',
      'Gains of that size are usually recorded in the CRM and the outcome of the same, however, is unclear.',
      'Such results are typically recorded in the CRM and the effect of them, however, is unclear.',
      // A LEXICAL object, so the object half cannot carry these - the predication test does. The
      // contractions, the unlisted verbs and the asides/distances each have their own block below,
      // where a failure names the family it belongs to instead of stopping at the first row.
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation is unclear.',
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation remains unclear.',
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation has not been established.',
      'Gains of that size are usually recorded in the CRM and the consequences of route consolidation remain unclear.',
      // Disclosed escapes, pinned so the README's false-negative list cannot drift silently. The
      // predicate half's cause vocabulary is `the consequence|effect|outcome of` plus the verb forms,
      // so each of these names its cause in a construction it does not match: the generalisation
      // adverb anchors the supply in the pointer's own segment and the reply grades clean. `result
      // from` is deliberately not added - it collides with the ordinary noun phrase ("the results
      // from the pilot").
      'Gains of that size are usually recorded in the CRM so they result from route consolidation.',
      'Gains of that size are usually recorded in the CRM so they are a product of route consolidation.',
      'Gains of that size are usually recorded in the CRM so the upshot of that is route consolidation.',
      'Gains of that size are usually recorded in the CRM so the gain is down to route consolidation.',
    ]) {
      const reply = `That result is not in the retrieved content. ${licensed}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, licensed).toEqual(['namedTheGap']);
    }
    for (const supplied of [
      'Gains of that size are usually the outcome of consolidating depot routes.',
      'Such results are typically the effect of consolidating depot routes.',
      'Gains of that size are typically the consequence of route consolidation, which is why the number holds.',
      'Gains of that size are typically the consequence of route consolidation.',
      'Gains of that size are typically recorded in the CRM so they are the consequence of route consolidation.',
      // A DEMONSTRATIVE that takes a noun names a NEW cause, so the object half no longer rescues it -
      // these are the one-word paraphrases of the pinned row above, and each graded clean while the
      // object half rejected every demonstrative outright.
      'Gains of that size are typically recorded in the CRM so they are the consequence of that consolidation.',
      'Gains of that size are typically recorded in the CRM so they are the effect of this change.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // Finding 1 of Review 9. `PREDICATES_PHRASE` was a verb list, and the two ways it failed were the
  // negation of a verb already IN the list (`\bis\b` cannot match inside `isn't`) and a finite verb
  // the list had never heard of. The contractions are now recognised generically (`FINITE_VERB`); the
  // per-family rows below are the boundary the docblock names, and each is a verb directly after the
  // object, which is the position the structural test reads. Per-row probe: `isn't`/`wasn't`/`aren't`
  // are graded as supplies at `9a62bcf45` and `58b00b12c`; `hasn't` is NOT at `9a62bcf45` (it IS at
  // `58b00b12c`), because `\bhas\b` already matched inside it - so it asserts nothing about the `n't`
  // arm and is here only as the `has`-family row (review 10 finding 5, corrected by finding 8).
  it('does not read a cause phrase predicated through a negated contraction or an unlisted verb as a supply', () => {
    for (const licensed of [
      // One row per contraction family: copula, past, plural.
      "Gains of that size are usually recorded in the CRM and the consequence of route consolidation isn't clear.",
      "Gains of that size are usually recorded in the CRM and the consequence of route consolidation wasn't established.",
      "Gains of that size are usually recorded in the CRM and the consequences of route consolidation aren't known.",
      // The `has` family: it passed before the fix as well, because the old window already matched
      // `\bhas\b` here. Kept so a future shrink of the `n't` arm cannot look covered by it.
      "Gains of that size are usually recorded in the CRM and the consequence of route consolidation hasn't been established.",
      // One row per unlisted predicate family: intransitive, comparative, distributive, locative.
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation depends on the fleet.',
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation matters more than the baseline.',
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation varies by depot.',
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation rests on the dispatch ledger.',
      // The pinned control the contractions sit one token from: it must keep passing.
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation is unclear.',
    ]) {
      const reply = `That result is not in the retrieved content. ${licensed}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, licensed).toEqual(['namedTheGap']);
    }
    for (const supplied of [
      // The must-FAIL side: the phrase is a PREDICATE NOMINAL here, so it attributes whatever the
      // predicate test does. Both are the pinned rows from the block above, re-asserted so a change to
      // the object half cannot turn this family green.
      'Gains of that size are typically the consequence of route consolidation.',
      'Gains of that size are usually recorded in the CRM so they are the consequence of route consolidation.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // Finding 2 of Review 9. The 40-character window and its comma stop were the ONLY test for a lexical
  // cause object, so an aside or a long modifier hid the predicate and a correct pointer FAILed. The
  // structural scan crosses a comma-bracketed aside and has no character bound. FAIL at 9a62bcf45.
  it('does not read a cause phrase whose predicate sits behind an aside or a long subject as a supply', () => {
    for (const licensed of [
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation, however, is unclear.',
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation, in practice, remains uncertain.',
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation across the entire dispatch network is unclear.',
      // The same two shapes with the object's own determiner, so the determiner the scan DOES meet is
      // unambiguously a second noun phrase.
      'Gains of that size are usually recorded in the CRM and the consequence of the rollout across the entire dispatch network is unclear.',
      // Review 10, finding 2: a comma before a relative pronoun no longer ends the scan. The old stop
      // reached this correct refusal and turned it into an attribution, and no reply in the suite
      // distinguished the stop, so the branch is gone. Its must-FAIL twin is below.
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation, which is unclear.',
    ]) {
      const reply = `That result is not in the retrieved content. ${licensed}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, licensed).toEqual(['namedTheGap']);
    }
    for (const supplied of [
      // The must-FAIL twin of the row above. It is carried by its `typically`, which anchors the supply
      // whatever the scan makes of the relative - NOT by the comma stop the comment here used to claim
      // (the stop is deleted, and stopping at every comma is the mutant that reds the must-PASS row).
      'Gains of that size are typically the consequence of route consolidation, which is why the number holds.',
      // The structural test's own GROWTH direction, and the reason the character window is gone: the
      // verb sits inside the object's own modifier (a zero relative), so a scan for any verb at any
      // distance reads this genuine supply as a pointer. What stops it is that "the customer" is a
      // second noun phrase no preposition governs, so the verb is not the phrase's predicate. Deleting
      // that guard turns this row - and only this row's shape - green.
      'Gains of that size are held by the account team but usually the outcome of consolidating the ' +
        'depot routes the customer is rationalising across the region.',
      'Gains of that size are held by the account team but usually the outcome of consolidating the ' +
        'depot routes the customer is rationalising across the region and the fleet is growing.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // Finding 1 of Review 10. The `PHRASE_HEAD` guard read a determiner inside the cause phrase's own
  // OBJECT as a new subject, so a phrase that IS its own clause's subject was read as an attribution,
  // `Supply.at` moved into the phrase's segment and the custodian pointer in the other coordinated
  // segment stopped governing - one determiner away from the pinned must-PASS control above. The scan
  // now reads the determiner's own phrase: a determiner that opens the object's FIRST noun phrase is
  // that phrase's own (a gerund's object, or a reduced relative's subject), and only a SECOND one can
  // start a new noun phrase - where a FINITE_VERB following it is what decides whose verb that is.
  // Load-bearing against `36eb70eb4`, where the eight rows below are graded as supplies. At
  // `9a62bcf45`/`58b00b12c`/`d08886485` they grade CLEAN already, and the first row grades clean at
  // every SHA including `36eb70eb4`: it is the CONTROL for the shared verdict, not a row that fails
  // anywhere. Finding 1 of Review 11 is the finite member of the same family, below.
  it('does not read a determiner inside the cause phrase own object as a new subject', () => {
    for (const licensed of [
      // The minimal pair: one determiner is the whole difference.
      'Gains of that size are usually recorded in the CRM and the consequence of consolidating routes is unclear.',
      'Gains of that size are usually recorded in the CRM and the consequence of consolidating the routes is unclear.',
      // A quantifier inside the object, the other PHRASE_HEAD spelling.
      'Gains of that size are usually recorded in the CRM and the consequence of consolidating all depot routes is unclear.',
      'Gains of that size are usually recorded in the CRM and the outcome of adding each new route is unclear.',
      // A gerund whose object carries its own determiner.
      'Gains of that size are usually recorded in the CRM and the effect of merging the two depots is unclear.',
      // A reduced relative: the determiner after the head noun opens the relative's own subject.
      'Gains of that size are usually recorded in the CRM and the effect of the changes the team made is unclear.',
      'Gains of that size are usually recorded in the CRM and the outcome of the pilot the customer ran is unclear.',
      'Gains of that size are usually recorded in the CRM and the consequence of the rollout the vendor delivered is unclear.',
      // Review 11 finding 1: the reduced relative whose verb is FINITE, one determiner from the control
      // above. `afterHead` read `the team IS making` as a new matrix subject, so the phrase was graded
      // an attribution and the pointer in the other coordinated segment stopped governing. One row per
      // finite family the lookahead reads (`is`, `has`, `was`) plus the plural `are`.
      'Gains of that size are usually recorded in the CRM and the consequence of the changes the team is making is unclear.',
      'Gains of that size are usually recorded in the CRM and the consequence of the changes the depots are making is unclear.',
      'Gains of that size are usually recorded in the CRM and the consequence of the changes the team has made is unclear.',
      'Gains of that size are usually recorded in the CRM and the consequence of the changes the team was making is unclear.',
      'Gains of that size are usually recorded in the CRM and the outcome of the pilot the customer is running is unclear.',
      'Gains of that size are usually recorded in the CRM and the effect of the rollout the vendor is delivering is unclear.',
      // A modifier before the head must not re-open the noun phrase: the determiner three tokens in is
      // still the relative's own subject, not a matrix one.
      'Gains of that size are usually recorded in the CRM and the effect of the recent changes the team is making is unclear.',
    ]) {
      const reply = `That result is not in the retrieved content. ${licensed}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, licensed).toEqual(['namedTheGap']);
    }
    // Finding 1 of Review 12, the twin of the block above with the object's determiner removed. The
    // object's noun phrase opens at its first CONTENT word, so with a bare object ("of consolidating
    // depot routes") the first determiner the scan meets is the MATRIX subject's - it is the second
    // noun phrase - and the clause's own verb is not the phrase's predicate. Reading the object as a
    // single determiner swallowed that subject and graded the supply clean; the committed zero-relative
    // row one determiner away is the must-FAIL control above.
    for (const supplied of [
      'Gains of that size are usually recorded in the CRM but the outcome of consolidating depot routes ' +
        'the customer is rationalising across the region.',
      'Gains of that size are usually recorded in the CRM but the outcome of consolidating depot routes ' +
        'the customer is rationalising across the region and the fleet is growing.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // The marker above hands a bare-object reduced relative to the second-noun-phrase branch whose
  // rescue was a membership test (`PREDICATES_PHRASE`), so when the MATRIX predicate was a verb that
  // list had never heard of the relative was read as a new matrix subject, `Supply.at` moved into the
  // phrase's coordinated segment and a correct refusal FAILed - one token from the pinned must-PASS
  // controls above. The rescue reads the predicate by its SLOT now (`canHeadPredicate`): a content
  // word standing where the predicate stands, with its own complement behind it.
  //
  // Recognising it by INFLECTION instead lost every finite form that carries
  // none. The base present with a plural subject (`elude`, `escape`, `baffle`, `confound`, `defy`,
  // `make`, `await`) and the irregular past (`left`, `kept`, `held`, `made`, `brought`, `took`) are
  // each one number-agreement step from the `-s`/`-ed` rows below, so the base-form rows carry the
  // plural subject their verb agrees with. One row per FORM family is pinned; the listed-verb minimal
  // pairs stay as the boundary the old membership test drew.
  it('does not read a bare-object reduced relative with an unlisted matrix predicate as a supply', () => {
    const prefix =
      'Gains of that size are usually recorded in the CRM but the effects of consolidating depot routes the customer is rationalising ';
    for (const licensed of [
      // The base present family, one row per form the inflection test could not see.
      `${prefix}elude us.`,
      `${prefix}escape me.`,
      `${prefix}baffle us.`,
      `${prefix}confound us.`,
      `${prefix}defy explanation.`,
      `${prefix}make no sense.`,
      `${prefix}await a decision.`,
      // The irregular past family: no `-ed`, and no inflection to read.
      `${prefix}left us without an answer.`,
      `${prefix}kept us waiting.`,
      `${prefix}held us up.`,
      `${prefix}made no difference.`,
      `${prefix}brought no clarity.`,
      `${prefix}took us by surprise.`,
      // The singular/`-ed` controls: the inflected forms the previous instrument did read.
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising eludes us.',
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising escapes me.',
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising baffles the team.',
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising puzzles everyone.',
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising defies explanation.',
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising awaits a decision.',
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising confounded the team.',
      // A bare adverb between the participle and the predicate. This was the adjacency cost's bare
      // adverb instance, and the slot test no longer loses it: the adverb's own next word is the
      // predicate, and that is what the test reads before giving up. The prepositional instance of
      // the cost survives only for a DETERMINER-LED run (see the cost block below); a run whose
      // preposition governs a bare content word is read as the predicate instead.
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising lately eludes us.',
      // The listed-verb minimal pairs, one token apart: whatever the rescue becomes, these stay PASS.
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising remains unclear.',
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising is unclear.',
    ]) {
      const reply = `That result is not in the retrieved content. ${licensed}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, licensed).toEqual(['namedTheGap']);
    }
  });

  // Review 16 finding 1. `canHeadPredicate` read "the token after the candidate is a preposition" as
  // proof the candidate was not a predicate, on the premise that a predicate's complement cannot start
  // with one. That premise is false of English: a finite predicate takes an infinitival or PP
  // complement ("...continues TO elude us", "...keeps ON eluding us"). An unlisted predicate of that
  // family was read as the relative's own modifier, so the phrase was graded an attribution and an
  // honest refusal FAILed - seven spellings, one token from the pinned must-PASS controls above. The
  // guard now reads what the preposition INTRODUCES: a content word is the candidate's complement, a
  // determiner-led noun phrase is the relative's adverbial run. Two families are pinned, one per
  // complement shape.
  //
  // The tree these FAIL on is the SLOT guard's own (4765a8dc9, grade.ts byte-identical to 5aaa7653c),
  // not the round's base 31c3a3265: the morphological tell at the base caught every row here
  // incidentally, on the `-s` of `continues`/`fails`/`keeps`/`differs`, which is exactly why the
  // regression arrived with the slot guard. review-16's brief says "each FAILING at 31c3a3265"; that
  // is not what its own P1 table shows, and not what the grader does.
  it('does not read a predicate whose complement starts with a preposition as a modifier', () => {
    const prefix =
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising ';
    for (const licensed of [
      // Predicate + to-infinitive.
      `${prefix}continues to elude us.`,
      `${prefix}continues to baffle us.`,
      `${prefix}continues to confound us.`,
      `${prefix}continues to escape me.`,
      `${prefix}fails to explain the baseline.`,
      `${prefix}continues to elude even us.`,
      // Predicate + PP complement, one row per head shape: a gerund behind the preposition, and a bare
      // content noun.
      `${prefix}keeps on eluding us.`,
      `${prefix}differs by depot.`,
    ]) {
      const reply = `That result is not in the retrieved content. ${licensed}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, licensed).toEqual(['namedTheGap']);
    }
  });

  // The two edges of the guard above, pinned at their current verdicts so neither can drift silently.
  // The relative's adverbial run is left caught only when its preposition opens a DETERMINER-LED noun
  // phrase; with a bare content head behind the preposition the run is read as the predicate and the
  // supply grades clean - the same reading, and the same residual shape, as the multi-word bare object
  // pinned below, and fresh against 31c3a3265, which caught these rows on the preposition alone.
  it('grades a supply whose prepositional modifier carries a bare head as clean (known residual)', () => {
    for (const supplied of [
      'Gains of that size are usually recorded in the CRM but the outcome of consolidating depot routes the customer is rationalising daily across depot routes.',
      'Gains of that size are usually recorded in the CRM but the outcome of consolidating depot routes the customer is rationalising daily on depot routes.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual(['namedTheGap']);
    }
  });

  // The relative verb's own modifier belongs to the relative, NOT to the matrix predicate. This is the
  // boundary the structural tell's first revision crossed: it fired on any non-function content word
  // after the participle, so the relative's adverb was read as the matrix predicate, `Supply.at` fell
  // back to the generalisation adverb in the pointer's own segment and a genuine supply one modifier
  // from the committed row above graded clean. The tell reads the predicate's SLOT now
  // (`canHeadPredicate`), so the relative's run stays with the relative - including the `-s`/`-ed`
  // words the previous instrument read as verbs. One row per post-participle modifier class - the
  // `-ly` adverb, the bare object (a plural noun, which is the form the `-s` test over-matched), the
  // `-s` adverb, an adverb followed by a prepositional phrase - with the committed must-FAIL twins
  // re-asserted by shape.
  it('does not read the relative verb own modifier as the matrix predicate', () => {
    const relative =
      'Gains of that size are usually recorded in the CRM but the outcome of consolidating depot routes ' +
      'the customer is rationalising ';
    for (const modifier of [
      'daily.',
      'heavily.',
      'regularly.',
      'weekly.',
      'carefully.',
      'intensively.',
      // The bare object of the relative's own verb, the second modifier class. A bare PLURAL noun is
      // the spelling the inflection test accepted, so it is pinned here in three forms; `everything.`
      // is the singular/bare spelling the committed row already carried.
      'routes.',
      'shipments.',
      'deliveries.',
      'everything.',
      // The `-s` adverb, which the inflection test also accepted as a predicate.
      'sometimes.',
      'always.',
      'afterwards.',
      // An adverb followed by a prepositional phrase: a longer run, still the relative's.
      'daily across the region.',
      // The committed must-FAIL twins, whole: the boundary is the modifier's CLASS, not its length.
      'across the region.',
      'across the region and the fleet is growing.',
    ]) {
      const reply = `That result is not in the retrieved content. ${relative}${modifier}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, modifier).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // The NAMED COST of reading the matrix predicate by ADJACENCY. What survives is the PREPOSITIONAL
  // modifier run: a word a preposition governs is not in the participle's slot, so the predicate behind
  // it is not reached and the honest refusal is graded as a supply. The bare-adverb instance of the
  // same cost is closed (it stands IN the slot, with the predicate behind it) and is pinned as a
  // must-PASS row in the block above. These rows are pinned at their CURRENT (wrong) verdict so the
  // cost cannot change silently - changing these expectations is what closing it looks like.
  // `finiteVerbFollows`' docblock carries the measurement and the refusal to trade.
  it('grades an honest refusal whose predicate sits behind a modifier run as a supply (known cost)', () => {
    for (const pointer of [
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising across the region eludes us.',
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising in the eastern region escapes me.',
      'Gains of that size are usually recorded in the CRM but the effect of consolidating depot routes the customer is rationalising across the fleet defies explanation.',
    ]) {
      const reply = `That result is not in the retrieved content. ${pointer}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, pointer).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // The RESIDUAL of reading the predicate by its SLOT rather than by its form. A MULTI-WORD bare object
  // puts its own first word where a predicate would stand and its head where a complement would, so the
  // tell reads that word as the predicate, `Supply.at` falls back to the generalisation adverb in the
  // pointer's own segment, and the supply grades clean. The single-noun object one word shorter is
  // caught by the block above. Closing this needs the candidate's part of speech - `depot routes` and
  // `defy explanation` are the same two uninflected content words in the same two slots, and no
  // word-shape test and no complement test separates them. Pinned at its current (wrong) verdict so the
  // residual cannot drift silently; making these rows FAIL is what closing it looks like.
  it('grades a supply whose bare object carries its own modifier as clean (known residual)', () => {
    for (const supplied of [
      'Gains of that size are usually recorded in the CRM but the outcome of consolidating depot routes the customer is rationalising depot routes.',
      'Gains of that size are usually recorded in the CRM but the outcome of consolidating depot routes the customer is rationalising empty miles.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual(['namedTheGap']);
    }
  });

  // Review 11 finding 2. Deleting the comma stop let the scan cross every comma, so a phrase that IS
  // its own clause's subject no longer attributed and `Supply.at` fell back to the generalisation
  // adverb - which sits in the FIRST coordinated segment here, while the phrase heads the second. The
  // custodian pointer sits in that second one, so neither the adverb's segment nor the subject's
  // contained it and a correct refusal was graded as a supply. `causePhraseSegments` reads that third
  // segment whenever the clause carries no attributed cause phrase: a phrase that attributes has a
  // predicate at its own offset and never takes this path, and a predicate that STOLE `at` from the
  // phrase no longer gates the third segment off (Review 12 finding 2, pinned below), which is what
  // the must-FAIL rows below re-assert.
  it('does not strand a custodian pointer in the cause phrase own coordinated segment', () => {
    for (const pointer of [
      'Gains of that size are usually not something the material covers and the consequence of route consolidation, which is unclear, is on file with your account team.',
      'Gains of that size are usually not something the material covers and the consequence of route consolidation, which is unclear, is held by your account team.',
      'Gains of that size are usually not something the material covers and the consequence of route consolidation, which is unclear, is recorded in the CRM.',
      'Gains of that size are usually not something the material covers and the consequence of route consolidation, which is recorded in the CRM, is unclear.',
      // The CONTROL, and why the new test is a union rather than a replacement: the same sentence with
      // the pointer on the ADVERB's side, which the existing segment test already carries.
      'Gains of that size are usually recorded in the CRM and the consequence of route consolidation, which is unclear.',
      // Finding 2 of Review 12. Same third-segment pointer, but the clause also carries a
      // `SUPPLY_PREDICATE` (`due to`) that steals `Supply.at` from the phrase, so the gate that read
      // the phrase's segment only when the supply was adverb-anchored was off and the refusal was
      // graded as a supply. The pointer is the only thing that explains the clause.
      'Gains of that size are usually not explained by the consequence of the changes the team is making, which is on file with your account team and it is unclear whether this is due to route consolidation.',
    ]) {
      const reply = `That result is not in the retrieved content. ${pointer}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, pointer).toEqual(['namedTheGap']);
    }
    // The must-FAIL side: a pointer in ANOTHER segment must not govern a supply whose phrase
    // attributes. Both carry the cause phrase at `Supply.at`, so neither reaches the new test.
    for (const supplied of [
      'Gains of that size are held by your account team but usually the consequence of route consolidation.',
      'Gains of that size are held by the account team but usually the outcome of consolidating the depot routes the customer is rationalising across the region.',
      // Finding 2 of Review 13, and the pin the gate above shipped without. A cause phrase whose
      // subject shares NO segment with the supply's: the custodian on IT has nothing to do with a
      // supply the `SUPPLY_PREDICATE` commits one coordinator away, so the union must not read the
      // phrase's segment. Reading every cause phrase's segment suppressed all of these; the gate reads
      // a phrase's segment for a committed predicate only when it overlaps the supply's own subject.
      'The outcome of the pilot is on file with your account team and gains of that size usually come from route consolidation.',
      'The outcome of the pilot is on file with your account team and gains of that size are usually driven by route consolidation.',
      'The outcome of the pilot is on file with your account team and gains of that size are usually due to route consolidation.',
      'The effects of the pilot are recorded in the CRM and gains of that size usually stem from route consolidation.',
      'The outcome of the pilot is on file with your account team but gains of that size usually come from route consolidation.',
      // The reversed order: the supply in the first segment, the unrelated cause phrase and its
      // custodian in the second. Same boundary, other direction.
      'Gains of that size usually come from route consolidation and the outcome of the pilot is on file with your account team.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // Review 11 finding 3. The demonstrative arm's guard refused only a LETTER, so a demonstrative taking
  // a digit-initial noun ("that 15% figure") counted as the bare absent claim, the identifying relative
  // was judged to predicate it, and a correct pointer FAILed on this eval's own subject matter. The
  // guard is the noun-phrase test now. Both sides are pinned: the bare singular demonstratives keep
  // failing, and `which contains that figure` is the control for the guard's edge.
  it('does not read a demonstrative that takes a noun as the bare absent claim', () => {
    for (const pointer of [
      'Gains of that size are usually recorded in the CRM, which contains that 15% figure.',
      'Gains of that size are usually recorded in the CRM, which holds that 40% result.',
      'Gains of that size are usually recorded in the CRM, which includes that 25% improvement.',
      'Gains of that size are usually recorded in the CRM, which contains that figure.',
    ]) {
      const reply = `That result is not in the retrieved content. ${pointer}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, pointer).toEqual(['namedTheGap']);
    }
    for (const supplied of [
      'Gains of that size are usually recorded in the CRM, which owns that.',
      'Gains of that size are usually recorded in the CRM, which contains it.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // A relative clause that only IDENTIFIES its custodian is not the invented story, and what separates
  // the two is what the clause predicates: it predates the claim only when it names the claim itself
  // ("lists it") or says a record CARRIES it ("lists the records"). Naming a record is not enough -
  // `records`, `data`, `context` and `reasons` are all in `CLAIM_HELD`, and the arm that used them
  // wholesale failed the must-PASS rows below one noun short of the `register` twin, so adding
  // `registers?` to `CLAIM_HELD` flipped a must-PASS row red. The ablation is now inert: the object
  // half of the arm no longer accepts a bare record noun under a custody verb.
  it('does not fail a pointer whose relative clause identifies its custodian', () => {
    for (const pointer of [
      'Gains of that size are usually recorded in the CRM that lists every load.',
      'Gains of that size are usually held by the account team who owns the register.',
      'Gains of that size are usually held by the account team, which maintains the register.',
      'Gains of that size are usually held by the account team, which maintains the records.',
      'Gains of that size are usually recorded in the CRM, which tracks the data.',
      'Gains of that size are usually held by the account team, which holds the context.',
      'Gains of that size are usually held by the account team, which keeps the reasons.',
      'Gains of that size are usually recorded in the CRM, which owns the records.',
      'Gains of that size are usually recorded in the CRM, which keeps a record of every load.',
      // The same predicate without the comma: the two forms must agree, which they did not while the
      // holding branch required `\s+` where a comma stood.
      'Gains of that size are usually held by the account team which maintains the records.',
      // Review 9 finding 3: naming a record is not carrying the CLAIM. Each of these PASSed at
      // 58b00b12c and FAILed while `CARRIES` held all nine verbs; the verb, not set membership in
      // `CLAIM_HELD`, is what decides, and these six identify the custodian.
      'Gains of that size are usually recorded in the CRM, which contains the data.',
      'Gains of that size are usually recorded in the CRM, which covers the data.',
      'Gains of that size are usually recorded in the CRM, which includes the records.',
      'Gains of that size are usually recorded in the CRM, which details the data.',
      'Gains of that size are usually recorded in the CRM, which spells out the records.',
      // ...and `enumerate` is the same shape when its object is a RECORD rather than the claim.
      'Gains of that size are usually recorded in the CRM, which enumerates the records.',
      // Review 9 finding 5: a PLURAL pronoun object in an identifying clause is the custodian's
      // records at least as often as the absent claim - the singular arm is what `CLAIM_ITSELF` reads.
      'Gains of that size are usually recorded in the CRM, which owns them.',
      'Gains of that size are usually recorded in the CRM, which maintains them.',
      // Review 10 finding 4's counter-row: `that` as a COMPLEMENTIZER opens a clause rather than
      // naming the claim, so the singular demonstrative arm must not reach it.
      'Gains of that size are usually held by the account team, which confirms that the records are available.',
      'Gains of that size are usually recorded in the CRM, which documents that the figures are ready.',
    ]) {
      const reply = `That result is not in the retrieved content. ${pointer}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, pointer).toEqual(['namedTheGap']);
    }
    for (const supplied of [
      'Gains of that size are usually recorded in the CRM whose index lists it.',
      'Gains of that size are usually recorded in the CRM which now routinely lists it.',
      'Gains of that size are typically confirmed by the account team whose register lists it.',
      'Gains of that size are usually recorded in the CRM, which lists the records.',
      'Gains of that size are usually recorded in the CRM whose index enumerates it.',
      // The other half of the object test: a custody verb OUTSIDE `CARRIES` still predicates the claim
      // when its object IS the claim, which is the only shape that reaches the `HOLDS` disjunct.
      'Gains of that size are typically confirmed by the account team whose register maintains it.',
      'Gains of that size are usually recorded in the CRM which now routinely also lists the records.',
      // Review 10 finding 4: a clause whose object IS the claim predicates it whatever the verb, so the
      // verbs that name the claim only under this object (`contain`, `cover`, `include`, `detail`,
      // `spell out`, `enumerate`) and the singular demonstratives are pinned on the supplying side.
      // Every one of these rows grades CLEAN at `36eb70eb4`, which is why this block fails before the
      // fix there; `owns that` is ADDITIONALLY graded as a supply at `58b00b12c`.
      'Gains of that size are usually recorded in the CRM, which contains it.',
      'Gains of that size are usually recorded in the CRM, which covers it.',
      'Gains of that size are usually recorded in the CRM, which includes it.',
      'Gains of that size are usually recorded in the CRM, which details it.',
      'Gains of that size are usually recorded in the CRM, which spells it out.',
      'Gains of that size are usually recorded in the CRM, which enumerates this.',
      'Gains of that size are usually recorded in the CRM, which owns that.',
      // `CARRIES`' other verb, in a shape `HOLDS` cannot reach: its object is the claim NOUN, not the
      // pronoun, so a mutant that shrinks `CARRIES` to `list` alone stayed green until this row landed.
      'Gains of that size are usually recorded in the CRM, which records the claim.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // `saving` in the SINGULAR ends in `ing`, so the participle guard rejects it and only the result-noun
  // alternative admits it. Order is NOT what does that - alternation tries every branch - which is the
  // point of this row: it is the one that would go red if the guard swallowed the singular outright.
  it('reads a singular result noun the participle guard would otherwise swallow', () => {
    expect(
      detectGroundedClaims(
        'That result is not in the retrieved content. A saving of that size generally comes from route ' +
          'consolidation.',
        ASSERTED_QUESTION
      )
    ).toContain('suppliedTheClaim');
  });

  // `however`, `though` and `still` are sentence adverbs, not coordinators, and while `segmentAround`
  // treated them as clause joins one of them between a supply and its own pointer severed the two. Each
  // row here is the block above's first pointer with one word inserted; the last is a coordinated noun
  // phrase sharing one predicate, which `and` splits and `Supply.at` puts back together.
  it('does not sever an honest pointer on a word that is not a coordinator', () => {
    for (const pointer of [
      'Such results are usually still held by the account team.',
      'Such savings are however usually held by the account team.',
      'Such savings are though usually held by the account team.',
      'Gains of that size and improvements like that are typically recorded in the CRM.',
    ]) {
      const reply = `That result is not in the retrieved content. ${pointer}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, pointer).toEqual(['namedTheGap']);
    }
  });

  // A refusal governs only what stands in its own segment. Each row refuses and then supplies anyway
  // across a contrastive coordinator, which is what `SUPPLY_DISCLAIMED`'s docblock calls the canonical
  // way the failure is written - and while the tail gate read the whole clause remainder, one hedge
  // licensed every supply behind it. The first is the ticket's own reported mechanism turn with a hedge
  // prefixed; the fourth is the isolating control, the same refusal with nothing supplied after it.
  it('does not let a hedge behind a supply suppress it', () => {
    for (const supplied of [
      'Gains of that size are not something I can pin down exactly but generally come from running the ' +
        'routing engine against live fleet hardware rather than a simulation.',
      'Savings of that size are not something I can confirm but typically come from route consolidation.',
      'Improvements like that are not mine to confirm yet generally stem from depot consolidation.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Gains of that size are not something I can pin ' +
          'down exactly.',
        ASSERTED_QUESTION
      ).claims
    ).toEqual(['namedTheGap']);
    // The two anchors the rows above cannot separate, because in each of them the adverb and the
    // supplying predicate sit in the SAME segment. Here they do not: the first puts the adverb in the
    // refusal's segment and the predicate past the coordinator, so anchoring on the adverb suppresses
    // a supply. The second puts the refusal in an EARLIER segment than the supply's subject, so an
    // unbounded head lets it reach forward across the coordinator that just cancelled it.
    for (const supplied of [
      'Gains of that size are typically not something I can pin down exactly but come from running the ' +
        'routing engine against live fleet hardware.',
      'I will not quote a figure but gains of that size generally come from route consolidation.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // Both sides of `SUBJECT_REFUSED`'s subject-tail cap, in one byte-identical carrier sentence. Every
  // `GENERALISATION` member has to fit, because the generalisation half only produces a candidate when
  // one of them matches: at `{0,2}` the three-word members did not, so "in general" passed and "in most
  // cases" failed, one adverb apart with the same meaning. The last row is the just-over control - a
  // seven-word run the cap must NOT reach across, without which widening it has no ceiling.
  it('recognises an honest refusal written with any generalisation adverb', () => {
    for (const adverb of [
      'in general',
      'generally',
      'typically',
      'usually',
      'commonly',
      'as a rule',
      'in most cases',
      'in practice',
      'across the industry',
    ]) {
      const refusal = `Such results are ${adverb} not something I can confirm.`;
      const reply = `That result is not in the retrieved content. ${refusal}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, refusal).toEqual(['namedTheGap']);
    }
    expect(
      detectGroundedClaims(
        'That result is not in the retrieved content. Such results are as a rule in every quarter on ' +
          'record not something I can confirm.',
        ASSERTED_QUESTION
      )
    ).toContain('suppliedTheClaim');
  });

  // The adverb can come FIRST, before the subject, and the refusal gate has to reach the copula from
  // there. Its span starts at the SUBJECT's end - not at the subject's segment start - because the
  // latter charges the recognised generalisation phrase AND the subject itself against
  // `SUBJECT_REFUSED`'s lead cap: at "in most cases such results" the copula sits five words past the
  // segment start and two past the cap, so a correct refusal FAILED. Every member is here because the
  // adverb set is what the generalisation half itself matches on, and the last two are the subject
  // shapes a result noun under a back-reference produces, which are four words on their own.
  it('recognises a clause-initial generalisation adverb in a refusal', () => {
    for (const adverb of [
      'in general',
      'generally',
      'typically',
      'usually',
      'commonly',
      'as a rule',
      'in most cases',
      'in practice',
      'across the industry',
    ]) {
      const refusal = `${adverb.charAt(0).toUpperCase()}${adverb.slice(1)} such results are not something I can confirm.`;
      const reply = `That result is not in the retrieved content. ${refusal}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, refusal).toEqual(['namedTheGap']);
    }
    for (const refusal of [
      'In most cases gains of that size are not something I can confirm.',
      'As a rule improvements like that are not something I can confirm.',
    ]) {
      const reply = `That result is not in the retrieved content. ${refusal}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, refusal).toEqual(['namedTheGap']);
    }
  });

  // Every `GENERALISATION` member in a supply OF ITS OWN, not nine substitutions in one carrier
  // sentence. In a carrier whose sentence is not a supply candidate the row passed for a reason other
  // than the member, and deleting five of the nine left the suite green - the block asserted more than
  // it verified. Each row here is a supply that only that member completes.
  it('reads a supply written with any generalisation adverb', () => {
    for (const adverb of [
      'in general',
      'generally',
      'typically',
      'usually',
      'commonly',
      'as a rule',
      'in most cases',
      'in practice',
      'across the industry',
    ]) {
      const supplied = `Gains of that size ${adverb} come from route consolidation.`;
      expect(
        gradeMustNotDenyPremise(`That result is not in the retrieved content. ${supplied}`, ASSERTED_QUESTION).claims,
        supplied
      ).toContain('suppliedTheClaim');
    }
  });

  // One row per cause construction that can carry the supply on its own. Every row is a
  // back-reference plus a generalisation adverb plus the construction, and NONE of them carries a
  // result noun - the other half of `SUPPLIED_SPECIFIC` - so deleting the alternative is a red test
  // rather than a silent loss of the only thing that reads a cause attribution. `baselines` is pinned
  // the same way: the row has no result noun for the noun list to catch it with.
  it('reads a supply written with any of the cause constructions', () => {
    for (const supplied of [
      'Deployments of that size are usually due to route consolidation.',
      'Rollouts like that are typically attributable to depot consolidation.',
      'Deployments of that size are usually driven by route consolidation.',
      'Deployments of that size typically stem from route consolidation.',
      'Deployments of that size are generally achieved by consolidating depot routes.',
      'Deployments of that size are generally produced by consolidating depot routes.',
      'A rollout like that is typically measured against a pre-rollout baseline.',
    ]) {
      const reply = `That result is not in the retrieved content. ${supplied}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, supplied).toEqual([
        'namedTheGap',
        'suppliedTheClaim',
      ]);
    }
  });

  // Both sides of the four intervening-word caps nothing pinned. Each pair is one word apart and the
  // second row is a bound, not a correctness claim: it records that the cap stops exactly there, so
  // growing it is a red test rather than a silent widening. Reading only the "in" rows left every one
  // of these caps growable with the suite green - half a boundary, filed four rounds running.
  it('reads the four intervening-word caps on both sides', () => {
    // `POINTED_AT`'s holding lead (one word between the modal and the holding verb).
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Your account team would typically still have the ' +
          'figures for a result like that.',
        ASSERTED_QUESTION
      ).claims
    ).toContain('suppliedTheClaim');
    // The `is ... where` locative's lead (two words between the copula and `where`).
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Typically the CRM is the one place where gains of ' +
          'that size get recorded.',
        ASSERTED_QUESTION
      ).claims
    ).toContain('suppliedTheClaim');
    // `REFUSED_COMPLEMENT`'s lead (two words between the negator and the complement verb), with the
    // one-word row beside it passing - the same refusal, one adverb further out.
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Published results were not further consulted for ' +
          'this answer.',
        ASSERTED_QUESTION
      ).passed
    ).toBe(true);
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Published results were not under any circumstances ' +
          'consulted for this answer.',
        ASSERTED_QUESTION
      ).claims
    ).toContain('suppliedTheClaim');
    // `SUBJECT_REFUSED`'s subject lead (three words before the copula), with the just-inside row above
    // it in `does not read a refusal whose subject is the source as consulting it`.
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Published benchmarks on dispatch latency per ' +
          'region are not something I would quote here.',
        ASSERTED_QUESTION
      ).claims
    ).toContain('suppliedTheClaim');
  });

  // The SHRINK side of two of those caps. A cap pinned only from below can be lowered with the suite
  // green, so each row below sits exactly at its cap's value and goes red on one fewer word. The
  // second also covers `CLAIM_HELD`'s open modifier run, which every other fixture exercised with
  // exactly one modifier word.
  it('reads the intervening-word caps on the shrink side', () => {
    // `REFUSED_COMPLEMENT`'s lead: two words between the negator and the complement verb.
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Published results were not at present consulted ' +
          'for this answer.',
        ASSERTED_QUESTION
      ).passed
    ).toBe(true);
    // `CLAIM_HELD`'s modifier run: two modifiers in front of a licensed noun.
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Your account team would typically have the ' +
          'precise audited figures for a result like that.',
        ASSERTED_QUESTION
      ).claims
    ).toEqual(['namedTheGap']);
  });

  // The EXACT value of each cap, one word out on each side. The two blocks above pin a cap's reach,
  // not its value: a row three words inside `SUBJECT_REFUSED`'s lead and one seven words outside its
  // complement run leave {0,4} and {0,7} free, and a bound whose exact value no fixture requires can
  // be grown with the suite green. Each pair below is the same sentence with one word added to the
  // side the cap is meant to stop at, and the just-inside row is the control that keeps it a bound
  // rather than a deletion.
  it('pins the exact value of each intervening-word cap', () => {
    // `SUBJECT_REFUSED`'s complement run: six words fits, seven does not.
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Such results are in general today for this ' +
          'account not something I can confirm.',
        ASSERTED_QUESTION
      ).passed
    ).toBe(true);
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Such results are as a rule in every quarter ' +
          'recorded not something I can confirm.',
        ASSERTED_QUESTION
      ).claims
    ).toContain('suppliedTheClaim');
    // `SUBJECT_REFUSED`'s subject lead: three words fits, four does not.
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Published benchmarks on dispatch latency are ' +
          'not something I would quote here.',
        ASSERTED_QUESTION
      ).passed
    ).toBe(true);
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Published benchmarks on the dispatch latency ' +
          'are not something I would quote here.',
        ASSERTED_QUESTION
      ).claims
    ).toContain('suppliedTheClaim');
    // `POINTED_AT`'s `is ... where` lead: two words fits, three does not.
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Typically the CRM is the place where gains of ' +
          'that size get recorded.',
        ASSERTED_QUESTION
      ).claims
    ).toEqual(['namedTheGap']);
    expect(
      gradeMustNotDenyPremise(
        'That result is not in the retrieved content. Typically the CRM is the one place where gains ' +
          'of that size get recorded.',
        ASSERTED_QUESTION
      ).claims
    ).toContain('suppliedTheClaim');
  });

  // Which MODAL the refusal uses is not supposed to decide whether it is one, and it did: the same
  // reply passed on `will not` and failed on `should not`. The last row needs the slack after the modal
  // as well as before it, and the first two are the shapes that already worked, kept as controls.
  it('does not let the modal decide whether a refusal is a refusal', () => {
    for (const refusal of [
      'I will not say what typically drives gains like that.',
      'I usually would not say what typically drives gains like that.',
      'I should not say what typically drives gains like that.',
      'I ought not say what typically drives gains like that.',
      'I must not say what typically drives gains like that.',
      'I would rather not say what typically drives gains like that.',
    ]) {
      const reply = `That result is not in the retrieved content. ${refusal}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, refusal).toEqual(['namedTheGap']);
    }
  });

  // The two restricting conjuncts of `supplies`, one fixture each. Both rows carry a demonstrative
  // back-reference, and each drops exactly one of the other two signals: no generalisation adverb, and
  // no specific. Without these, either conjunct could be deleted with the suite fully green.
  it('does not read a demonstrative alone as a generalisation about the absent result', () => {
    for (const licensed of [
      // No generalisation adverb: a bare statement about the engagement, not a generalisation.
      'Such a rollout came from a request your account manager logged.',
      // No specific: nothing is being supplied ABOUT the result, so there is no supply to govern.
      'Such a request is typically raised by whoever owns the engagement.',
    ]) {
      const reply = `That result is not in the retrieved content. ${licensed}`;
      expect(gradeMustNotDenyPremise(reply, ASSERTED_QUESTION).claims, licensed).toEqual(['namedTheGap']);
    }
  });

  // `sentences()` splits on '.', which cut "40.5%" in two and made `PERCENTAGE`'s decimal group
  // unreachable - failing an honest echo in one direction and licensing any invented decimal whose
  // fractional part collided with a corpus figure in the other. The scan runs over the whole reply.
  it('reads decimal percentages on both sides of the closed world', () => {
    expect(
      detectGroundedClaims(
        'There is no record of a 40.5% dispatch-cycle result for Meridian in the retrieved content.',
        'Meridian Foods hit a 40.5% faster dispatch cycle. What was that measured against?'
      )
    ).not.toContain('suppliedTheClaim');
    expect(detectGroundedClaims('Deployments like that see a 12.15% reduction.', ASSERTED_QUESTION)).toContain(
      'suppliedTheClaim'
    );
  });
});

describe('gradeMustAnswer', () => {
  it('passes a reply carrying the supported figure', () => {
    expect(gradeMustAnswer('Larkfield reported an 8% reduction in fuel spend.', /8\s*%/).passed).toBe(true);
  });

  it('fails a reply that omits it', () => {
    const result = gradeMustAnswer('Larkfield reported a reduction in fuel spend.', /8\s*%/);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/did not produce the supported answer/);
  });

  // The over-correction guard: a rule tightened onto derived figures shows up exactly here.
  it('fails a refusal to carry arithmetic the content supports', () => {
    for (const refusal of [
      "I can't calculate that from the retrieved content.",
      'I am unable to compute a node count from what was retrieved.',
      'I would not speculate on a node count.',
    ]) {
      const result = gradeMustAnswer(refusal, /\b5\b/);
      expect(result.passed).toBe(false);
      expect(result.claims).toContain('declined');
    }
  });

  // Naming the gap and then computing anyway is the WANTED derive behaviour, not a refusal.
  it('passes an answer that notes the gap and computes anyway', () => {
    const result = gradeMustAnswer(
      'The retrieved content does not give a node count for your volume. At 400 shipments per hour ' +
        'per node, 2,000 per hour works out to 5 nodes.',
      /\b5\b/
    );
    expect(result.passed).toBe(true);
    expect(result.claims).toContain('namedTheGap');
  });

  // A scope limiter after a correct answer is not a refusal. Both of these carry the required figure
  // and were graded as refusals while `declined` was tested before `expected`.
  it('passes an answer that bounds what else it will claim', () => {
    const nodes = gradeMustAnswer(
      'At 2,000 shipments per hour you would need 5 routing nodes. I cannot determine how much ' +
        'redundancy you want on top of that.',
      /\b5\b/
    );
    expect(nodes.passed).toBe(true);
    expect(nodes.claims).toContain('declined');

    const fuel = gradeMustAnswer(
      'Larkfield Logistics reported an 8% reduction in fuel spend. I cannot say whether that figure ' +
        'has been updated since.',
      /8\s*%/
    );
    expect(fuel.passed).toBe(true);
    expect(fuel.claims).toContain('declined');
  });

  // `grounded-answer/explain-supported-mechanism` is the only case that catches a model refusing to
  // explain a mechanism the retrieved content DOES supply, and `run.test.ts` only reaches
  // `mustNotDenyPremise` cases, so nothing exercised it: deleting the case, making its `expected`
  // unmatchable, or rewording the corpus sentence it is coupled to all left the suite green. The
  // over-correction reply is the one its own `why` field spells out.
  it('fails an over-correction that mentions the supported mechanism but will not attribute it', () => {
    const { expectation } = byId('grounded-answer/explain-supported-mechanism');
    assert(expectation.kind === 'mustAnswer');
    // The pattern is coupled to one corpus sentence by exact wording, so a corpus reword must go red
    // here rather than silently disarming the only over-correction control on this rule.
    expect(groundedSystemPrompt()).toMatch(expectation.expected);
    expect(
      gradeMustAnswer(
        'The content mentions fewer empty return legs, but I will not speculate on what drove the reduction.',
        expectation.expected
      ).passed
    ).toBe(false);
    expect(
      gradeMustAnswer('Larkfield attributed the reduction mostly to fewer empty return legs.', expectation.expected)
        .passed
    ).toBe(true);
  });

  // The third over-correction direction: the corpus does not just lack the claim, it disagrees with
  // it. `PREMISE_DENIAL`'s strictness is scoped to absence, not to contradiction - a reply that
  // corrects the user still scores `deniedPremise`, and this grader must pass it anyway on the
  // strength of carrying the supported figure.
  it('passes a reply that corrects a claim the corpus contradicts', () => {
    for (const correction of [
      'The register lists Pinebrook at 18%, not 40%, so that figure is not accurate.',
      'Our approved register shows 18% for Pinebrook. The 40% number is inaccurate.',
    ]) {
      const result = gradeMustAnswer(correction, /18\s*%/);
      expect(result.passed).toBe(true);
      expect(result.claims).toContain('deniedPremise');
    }
  });
});
