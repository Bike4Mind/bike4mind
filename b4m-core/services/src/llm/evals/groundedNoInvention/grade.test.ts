/**
 * The grader is the only part of this eval that runs in CI, so it is the only part that can rot
 * unnoticed. The anchor fixture is the reply actually observed in production, with the partner and
 * figures replaced - this is a public repo. If that fixture ever grades clean, the eval has stopped
 * measuring the thing it was built for.
 */
import { describe, expect, it } from 'vitest';
import { detectGroundedClaims, gradeMustAnswer, gradeMustNotDenyPremise } from './grade';

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
    expect(detectGroundedClaims('That absence does not prove the 40% result never happened.')).toEqual([]);
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

  // The cost of admitting "does not appear": a hedged verdict must not buy a gap credit with it.
  it('does not read a hedged verdict as naming the gap', () => {
    expect(detectGroundedClaims('That figure does not appear to be accurate.')).not.toContain('namedTheGap');
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
