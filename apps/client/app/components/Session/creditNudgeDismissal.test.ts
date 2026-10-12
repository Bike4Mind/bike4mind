import { beforeEach, describe, expect, it } from 'vitest';
import { CREDIT_NUDGE_SNOOZE_MS, dismissCreditNudge, isCreditNudgeDismissed } from './creditNudgeDismissal';

const NOW = 1_700_000_000_000;

describe('creditNudgeDismissal', () => {
  beforeEach(() => window.localStorage.clear());

  it('is not dismissed by default', () => {
    expect(isCreditNudgeDismissed('u1', NOW)).toBe(false);
  });

  it('stays dismissed within 24h and expires after', () => {
    dismissCreditNudge('u1', NOW);
    expect(isCreditNudgeDismissed('u1', NOW + CREDIT_NUDGE_SNOOZE_MS - 1)).toBe(true);
    expect(isCreditNudgeDismissed('u1', NOW + CREDIT_NUDGE_SNOOZE_MS)).toBe(false);
  });

  it('does not carry one user dismissal over to another user on the same browser', () => {
    dismissCreditNudge('u1', NOW);
    expect(isCreditNudgeDismissed('u1', NOW)).toBe(true);
    expect(isCreditNudgeDismissed('u2', NOW)).toBe(false);
  });

  it('reports not dismissed and stores nothing when no user is loaded', () => {
    dismissCreditNudge(undefined, NOW);
    dismissCreditNudge(null, NOW);
    expect(window.localStorage.length).toBe(0);
    expect(isCreditNudgeDismissed(undefined, NOW)).toBe(false);
    expect(isCreditNudgeDismissed(null, NOW)).toBe(false);
  });

  it('ignores garbage and future timestamps', () => {
    window.localStorage.setItem('credit-nudge-dismissed-at:u1', 'nope');
    expect(isCreditNudgeDismissed('u1', NOW)).toBe(false);
    window.localStorage.setItem('credit-nudge-dismissed-at:u1', String(NOW + 5000));
    expect(isCreditNudgeDismissed('u1', NOW)).toBe(false);
  });
});
