import { describe, it, expect } from 'vitest';
import { buildInsufficientCreditsMessage } from './insufficientCreditsMessage';
import { InsufficientCreditsError } from './ChatCompletionProcess';

describe('buildInsufficientCreditsMessage', () => {
  it('produces a plain-language, action-oriented personal message with the credit numbers', () => {
    const msg = buildInsufficientCreditsMessage({ available: 120, required: 500 });
    expect(msg).toBe(
      "You're out of credits. This request needs about 500 credits, but only 120 are available. Add credits to keep going."
    );
  });

  it('names the organization and points org members at their admin (they cannot self-purchase)', () => {
    const msg = buildInsufficientCreditsMessage({ available: 0, required: 300, organizationName: 'Acme' });
    expect(msg).toContain('Your organization "Acme" is out of credits');
    expect(msg).toContain('about 300 credits');
    expect(msg).toContain('only 0 are available');
    expect(msg).toContain('Contact your organization administrator to add more credits.');
    // Org members can't buy credits themselves, so the personal "add credits" CTA copy
    // must not appear for them.
    expect(msg).not.toContain('Add credits to keep going.');
  });

  it('drops the old dead-end advice ("try a shorter prompt / reduce history")', () => {
    const msg = buildInsufficientCreditsMessage({ available: 1, required: 2 });
    expect(msg).not.toMatch(/shorter prompt|reduce.*history|more concise/i);
    // Steers the user to the real remedy instead.
    expect(msg).toMatch(/add credits/i);
  });
});

describe('InsufficientCreditsError', () => {
  it('carries the classifier code for genuine out-of-credits throws', () => {
    const err = new InsufficientCreditsError('out of credits', 'insufficient_credits');
    expect(err.code).toBe('insufficient_credits');
    expect(err.name).toBe('InsufficientCreditsError');
  });

  it('leaves the code unset when omitted (e.g. the dispute-pending fraud gate)', () => {
    const err = new InsufficientCreditsError('account under review');
    expect(err.code).toBeUndefined();
  });
});
