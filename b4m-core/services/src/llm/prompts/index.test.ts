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

  // Guards the round-2 fix for the multi-turn laundering loophole: grounding is scoped to labeled
  // Memory/Reference facts, and an earlier conversation claim (including the user's own) is explicitly
  // NOT such a fact - so a reword can't silently reopen "user asserted it a turn ago, so it's grounded."
  it('scopes grounding to labeled Memory/Reference facts, not an earlier conversation claim', () => {
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/under a\s+"Memory"\s+or\s+"Reference facts"\s+label/);
    expect(GROUNDED_NO_INVENTION_RULE).toMatch(/claim made earlier in the conversation.*is\s+not such a fact/i);
  });
});
