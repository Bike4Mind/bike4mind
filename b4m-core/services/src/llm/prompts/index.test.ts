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

  // Pins the enumeration itself (not just the "not covered" sentence that follows it) and the
  // "already given" qualifier - without this, the enumeration could collapse to "a specific fact" and
  // every test in this file would still pass, silently dropping the #1598 guard.
  it('names the specific kinds of claim the enumeration covers, even when the question presents one as given', () => {
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(
      /specific customer, organization, person, competitive win or\s+comparison, deal, price, or\s+figure/
    );
    expect(GROUNDED_NO_INVENTION_RULE).toContain('even if the question presents it as already given');
  });

  // The derive licence (triage_router STEP 1) depends on this rule staying scoped to facts asserted as
  // RETRIEVED, not to arithmetic on figures the request supplies inputs for - worth +25.2 composite,
  // and it regresses silently if this rule is ever widened to cover derived/computed figures. Negative
  // assertion so a reword that adds "derived" or "computed" language here fails loudly instead.
  it('does not extend to derived or computed figures - that licence lives in triage_router, not here', () => {
    expect(GROUNDED_NO_INVENTION_RULE).not.toMatch(/derive|derived|deriving|computed|computation/i);
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

  // The licence to leave a claim open was itself exploitable: a reply can decline the yes/no verdict
  // and still fill the named gap with an invented figure ("results like this typically land around
  // 20-25%"), which the clauses above never forbid because it isn't a denial or a ruling. This binds
  // the licence at the point it's granted rather than adding a rule elsewhere.
  it('binds the leave-it-open licence to not answering, including not answering from general knowledge', () => {
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/leaving it open means not answering it/);
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(
      /not\s+answering it from general knowledge, inference, or a plausible-sounding estimate/
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

  // Guards the round-2 fix for the multi-turn laundering loophole: grounding is scoped to labeled
  // Memory/Reference facts, and an earlier conversation claim (including the user's own) is explicitly
  // NOT such a fact - so a reword can't silently reopen "user asserted it a turn ago, so it's grounded."
  it('scopes grounding to labeled Memory/Reference facts, not an earlier conversation claim', () => {
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/under a\s+"Memory"\s+or\s+"Reference facts"\s+label/);
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/claim made earlier in the conversation.*is\s+not such a fact/i);
  });
});
