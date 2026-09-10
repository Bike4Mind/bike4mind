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

  it('passes an answer that scopes the absence and leaves the claim open', () => {
    const result = gradeMustNotDenyPremise(WANTED);
    expect(result.passed).toBe(true);
    expect(result.claims).toEqual(['corpusScopedAbsence']);
  });

  // The whole reason claims are detected per sentence: the wanted answer reaches for the same words
  // the defect does, one sentence later and negated. A whole-reply match would fail the correct reply.
  it('does not read a disclaimed denial as a denial', () => {
    expect(detectGroundedClaims('That does not mean the result did not happen')).toEqual([]);
    expect(detectGroundedClaims('I am not saying it was fabricated')).toEqual([]);
    expect(detectGroundedClaims('That is not to say the pilot never happened')).toEqual([]);
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
  it('reads a negated confirm scoped to the corpus as an absence claim', () => {
    expect(detectGroundedClaims('I cannot confirm that from the retrieved content')).toContain('corpusScopedAbsence');
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
    expect(result.reason).toMatch(/did not scope the absence/);
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
    expect(result.claims).toContain('corpusScopedAbsence');
  });
});
