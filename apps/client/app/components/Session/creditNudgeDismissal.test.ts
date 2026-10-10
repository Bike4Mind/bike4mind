import { beforeEach, describe, expect, it } from 'vitest';
import { CREDIT_NUDGE_SNOOZE_MS, dismissCreditNudge, isCreditNudgeDismissed } from './creditNudgeDismissal';

const NOW = 1_700_000_000_000;

describe('creditNudgeDismissal', () => {
  beforeEach(() => window.localStorage.clear());

  it('is not dismissed by default', () => {
    expect(isCreditNudgeDismissed(NOW)).toBe(false);
  });

  it('stays dismissed within 24h and expires after', () => {
    dismissCreditNudge(NOW);
    expect(isCreditNudgeDismissed(NOW + CREDIT_NUDGE_SNOOZE_MS - 1)).toBe(true);
    expect(isCreditNudgeDismissed(NOW + CREDIT_NUDGE_SNOOZE_MS)).toBe(false);
  });

  it('ignores garbage and future timestamps', () => {
    window.localStorage.setItem('credit-nudge-dismissed-at', 'nope');
    expect(isCreditNudgeDismissed(NOW)).toBe(false);
    window.localStorage.setItem('credit-nudge-dismissed-at', String(NOW + 5000));
    expect(isCreditNudgeDismissed(NOW)).toBe(false);
  });
});
