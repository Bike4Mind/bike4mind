import { describe, it, expect } from 'vitest';
import {
  blendFollowUpQueryVector,
  forcedRetrievalFollowUpContext,
  FORCED_RETRIEVAL_PRIOR_TURN_CHARS,
  looksLikeFollowUp,
} from './forcedRetrievalQuery';

describe('looksLikeFollowUp', () => {
  it('takes any short message, and a long one only when it points back', () => {
    expect(looksLikeFollowUp('what about their pricing?')).toBe(true);
    expect(looksLikeFollowUp('und die Preise?')).toBe(true);
    expect(
      looksLikeFollowUp('Given the rollout plan described earlier, how long would it take to onboard a team of forty?')
    ).toBe(true);
    expect(
      looksLikeFollowUp('Summarize the onboarding steps a new enterprise customer goes through during the first month')
    ).toBe(false);
  });
});

describe('forcedRetrievalFollowUpContext', () => {
  it('returns the last two user turns, oldest first, for a follow-up', () => {
    expect(
      forcedRetrievalFollowUpContext('and the second one?', ['first topic', 'second topic', 'third topic'])
    ).toEqual({ context: 'second topic\nthird topic', priorTurnsUsed: 2 });
  });

  it('clips each earlier turn so a pasted document cannot take over the query', () => {
    const result = forcedRetrievalFollowUpContext('what does it cost?', ['x'.repeat(5000)]);
    expect(result?.context).toHaveLength(FORCED_RETRIEVAL_PRIOR_TURN_CHARS);
  });

  it('ignores the current message when history still holds it, as on a first turn', () => {
    expect(forcedRetrievalFollowUpContext('what does it cost?', ['what does it cost?'])).toBeUndefined();
    expect(
      forcedRetrievalFollowUpContext('what does it cost?', ['tell me about the product', 'what does it cost?'])
    ).toEqual({
      context: 'tell me about the product',
      priorTurnsUsed: 1,
    });
  });

  it('leaves a self-contained message alone', () => {
    const message = 'Summarize the onboarding steps a new enterprise customer goes through during the first month';
    expect(forcedRetrievalFollowUpContext(message, ['tell me about the product'])).toBeUndefined();
  });

  it('has nothing to add without earlier turns', () => {
    expect(forcedRetrievalFollowUpContext('what does it cost?', undefined)).toBeUndefined();
    expect(forcedRetrievalFollowUpContext('what does it cost?', ['  '])).toBeUndefined();
  });
});

describe('blendFollowUpQueryVector', () => {
  it('returns a unit vector led by the message', () => {
    const blended = blendFollowUpQueryVector([0, 2], [3, 0], 0.5);
    expect(Math.hypot(...blended)).toBeCloseTo(1, 10);
    expect(blended[1]).toBeGreaterThan(blended[0]);
    expect(blended[0]).toBeGreaterThan(0);
  });

  it('weighs both sides at unit length, so a longer context vector does not count for more', () => {
    expect(blendFollowUpQueryVector([0, 1], [100, 0], 0.5)).toEqual(blendFollowUpQueryVector([0, 1], [1, 0], 0.5));
  });

  it('falls back to the message vector when the two cannot be combined', () => {
    expect(blendFollowUpQueryVector([0, 1], [1, 0, 0])).toEqual([0, 1]);
    expect(blendFollowUpQueryVector([0, 1], [0, 0])).toEqual([0, 1]);
  });
});
