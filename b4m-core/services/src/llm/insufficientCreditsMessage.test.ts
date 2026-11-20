import { describe, it, expect } from 'vitest';
import { buildInsufficientCreditsMessage, buildMemberCreditCapMessage } from './insufficientCreditsMessage';
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

  it('reports a negative balance as credits owed instead of a negative amount available', () => {
    const personal = buildInsufficientCreditsMessage({ available: -42.3, required: 50 });
    expect(personal).toContain('leaving 43 credits owed');
    expect(personal).toContain('Add credits to keep going.');
    expect(personal).not.toContain('-42');

    const org = buildInsufficientCreditsMessage({ available: -10, required: 50, organizationName: 'Acme' });
    expect(org).toContain('Your organization "Acme" is out of credits');
    expect(org).toContain('leaving 10 credits owed');
    expect(org).not.toContain('Add credits to keep going.');
  });

  it('uses the singular for a single credit owed', () => {
    expect(buildInsufficientCreditsMessage({ available: -0.3, required: 5 })).toContain('leaving 1 credit owed');
  });
});

describe('buildMemberCreditCapMessage', () => {
  it('reports the monthly cap, usage and reset date, and points the member at their admin', () => {
    const msg = buildMemberCreditCapMessage({
      used: 9,
      cap: 10,
      resetsAt: new Date('2026-11-01T00:00:00Z'),
      organizationName: 'Acme',
    });
    expect(msg).toContain('monthly per-member credit limit');
    expect(msg).toContain('for "Acme"');
    expect(msg).toContain('(9 of 10 credits used this month)');
    expect(msg).toContain('It resets on November 1.');
    expect(msg).toContain('Contact your organization administrator to raise your limit.');
  });

  it('falls back to a generic org label when the name is unknown', () => {
    const msg = buildMemberCreditCapMessage({ used: 5, cap: 5, resetsAt: new Date('2026-11-01T00:00:00Z') });
    expect(msg).toContain('for your organization');
    expect(msg).not.toContain('""');
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
