import { describe, expect, it } from 'vitest';
import { GROUNDED_NO_INVENTION_RULE } from './index';

// The knowledgeBaseRetrieve/knowledgeBaseSearch/ChatCompletionFeatures tests assert this rule is
// INJECTED into the retrieved-content wrapper; these assert the rule still SAYS what it must, so a
// future reword can't silently drop any of its guards.
describe('GROUNDED_NO_INVENTION_RULE', () => {
  it('forbids fabricated presence - abstain rather than invent a missing fact', () => {
    expect(GROUNDED_NO_INVENTION_RULE).toContain('not covered');
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/never attach a\s+citation/);
  });

  it('forbids fabricated absence - never deny a real offering just because retrieval missed it', () => {
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(
      /never state or imply that .*(does not exist|is not real|is not provided)/i
    );
    expect(GROUNDED_NO_INVENTION_RULE).toContain('rather than denying it');
  });

  // The observed escalation ran a correctly-scoped absence on into a verdict on the user's claim
  // ("the premise appears to be fabricated"). The fabricated-absence clause above did not reach it -
  // its enumeration is entity-shaped and a claimed RESULT is none of those - so this pins the sentence
  // that does. Text only; the behaviour is measured in evals/groundedNoInvention.
  it('forbids ruling on a premise the question asserts - absence is not a verdict', () => {
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/specific result,\s+engagement, or event/);
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(
      /report that it is not in the retrieved\s+content and leave the claim itself open/
    );
  });

  // The word list alone was measured insufficient: the model reached the same verdict as "No, it is
  // not accurate to say ...", which the list does not contain. These two pins are the clauses that
  // fixed it, and they are about the ACT rather than the vocabulary - so a reword that drops back to
  // policing words fails here rather than in production.
  it('declines the yes/no rather than only banning verdict words', () => {
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/accurate, true, or\s+correct, do not answer yes or no/);
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/may say the claim is unsupported, uncited, or not\s+approved/);
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(
      /never that it is\s+false, inaccurate, fabricated, invented, or made up/
    );
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/do not reach that verdict in other words/);
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/A register or approved list bounds what you may cite/);
  });

  // The anti-denial clause above was measured to produce its own over-correction: told to leave the
  // claim open, the model stopped ruling on it and started elaborating instead. "Leave it open" is
  // silent about what fills that space, so these pin the sentences that define the act and name the
  // licensed alternative - the same act-not-vocabulary shape as the clauses above, for the same
  // reason. Text only; the behaviour is measured in evals/groundedNoInvention.
  it('defines leaving a claim open as not answering it, and names what may be offered instead', () => {
    expect(GROUNDED_NO_INVENTION_RULE).toContain('Leaving it open means not answering it');
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(
      /do not explain how the asserted result was reached, what it was measured against, or what figures it involved/
    );
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(
      /not supply any of that from general knowledge, published results, or what is typically the case/
    );
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(
      /may offer instead is what the retrieved content does cover and where the claim could be confirmed/
    );
  });

  // Guards the round-2 fix for the multi-turn laundering loophole: grounding is scoped to labeled
  // Memory/Reference facts, and an earlier conversation claim (including the user's own) is explicitly
  // NOT such a fact - so a reword can't silently reopen "user asserted it a turn ago, so it's grounded."
  it('scopes grounding to labeled Memory/Reference facts, not an earlier conversation claim', () => {
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/under a\s+"Memory"\s+or\s+"Reference facts"\s+label/);
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/claim made earlier in the conversation.*is\s+not such a fact/i);
  });
});
