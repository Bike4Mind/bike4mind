import { describe, expect, it } from 'vitest';
import {
  activationStep,
  addBillingInterval,
  conversionWindowClosed,
  deriveRenewal,
  memberOutcome,
} from './acquisitionConversion';
import { paidWithinDays, type LedgerPayment, type PaymentLedger } from './paymentLedger';

const d = (iso: string) => new Date(iso);
const DAY = 86_400_000;

describe('paidWithinDays', () => {
  it.each([
    ['2026-01-01T23:59:59Z', 0, true],
    ['2026-01-31T00:00:00Z', 30, true],
    ['2026-01-31T23:59:59Z', 30, true],
    ['2026-02-01T00:00:00Z', 31, false],
    ['2025-12-31T23:59:59Z', -1, false],
  ])('a payment at %s (day %i) is within 30 days: %s', (paidAt, _day, expected) => {
    expect(paidWithinDays(d('2026-01-01T00:00:00Z'), d(paidAt), 30)).toBe(expected);
  });
});

describe('conversionWindowClosed', () => {
  const signup = d('2026-01-01T00:00:00Z');
  it('closes at the start of UTC day W+1 after the signup day', () => {
    expect(conversionWindowClosed(signup, 7, d('2026-01-08T23:59:59Z'))).toBe(false);
    expect(conversionWindowClosed(signup, 7, d('2026-01-09T00:00:00Z'))).toBe(true);
  });
  it('judges a late-evening signup by its UTC day', () => {
    expect(conversionWindowClosed(d('2026-01-01T23:59:59Z'), 7, d('2026-01-09T00:00:00Z'))).toBe(true);
  });
});

describe('addBillingInterval', () => {
  it.each([
    ['2026-01-15T10:00:00Z', 'month', 1, '2026-02-15T10:00:00.000Z'],
    ['2026-01-31T10:00:00Z', 'month', 1, '2026-02-28T10:00:00.000Z'],
    ['2026-11-30T00:00:00Z', 'month', 3, '2027-02-28T00:00:00.000Z'],
    ['2024-02-29T00:00:00Z', 'year', 1, '2025-02-28T00:00:00.000Z'],
    ['2026-01-01T00:00:00Z', 'week', 2, '2026-01-15T00:00:00.000Z'],
    ['2026-01-01T00:00:00Z', 'day', 3, '2026-01-04T00:00:00.000Z'],
  ])('%s + %i %s', (at, interval, count, expected) => {
    expect(addBillingInterval(d(at), interval as string, count as number)?.toISOString()).toBe(expected);
  });
  it('is null for an unknown interval or count', () => {
    expect(addBillingInterval(d('2026-01-01T00:00:00Z'), 'fortnight', 1)).toBeNull();
    expect(addBillingInterval(d('2026-01-01T00:00:00Z'), 'month', 0)).toBeNull();
  });
});

const sub = (at: string, fields: Partial<NonNullable<LedgerPayment['subscription']>> = {}): LedgerPayment => ({
  kind: 'subscription',
  at: d(at),
  reversed: false,
  subscription: { status: 'active', interval: 'month', intervalCount: 1, ...fields },
});

describe('deriveRenewal', () => {
  const followUpEnd = d('2026-04-01T00:00:00Z');
  it('counts a monthly sub whose period moved past its first renewal as renewed', () => {
    expect(deriveRenewal(sub('2026-01-10T00:00:00Z', { periodStartsAt: d('2026-03-10T00:00:00Z') }), followUpEnd)).toBe(
      'renewed'
    );
  });
  it('allows a day of slack before the first renewal date', () => {
    expect(deriveRenewal(sub('2026-01-10T12:00:00Z', { periodStartsAt: d('2026-02-09T13:00:00Z') }), followUpEnd)).toBe(
      'renewed'
    );
  });
  it('counts a sub still in its first period as not renewed', () => {
    expect(deriveRenewal(sub('2026-01-10T00:00:00Z', { periodStartsAt: d('2026-01-10T00:00:00Z') }), followUpEnd)).toBe(
      'notRenewed'
    );
  });
  it('is not due when a yearly sub renews after the follow-up', () => {
    expect(
      deriveRenewal(
        sub('2026-01-10T00:00:00Z', { interval: 'year', periodStartsAt: d('2026-01-10T00:00:00Z') }),
        followUpEnd
      )
    ).toBe('notDue');
  });
  it('dates the first renewal from the trial end', () => {
    const trial = sub('2026-01-01T00:00:00Z', {
      trialEndsAt: d('2026-01-15T00:00:00Z'),
      periodStartsAt: d('2026-02-01T00:00:00Z'),
    });
    expect(deriveRenewal(trial, followUpEnd)).toBe('notRenewed');
  });
  it('is unavailable without an interval or period start, never not renewed', () => {
    expect(deriveRenewal(sub('2026-01-10T00:00:00Z', { periodStartsAt: undefined }), followUpEnd)).toBe('unavailable');
    expect(
      deriveRenewal(
        sub('2026-01-10T00:00:00Z', { interval: undefined, periodStartsAt: d('2026-03-10T00:00:00Z') }),
        followUpEnd
      )
    ).toBe('unavailable');
  });
});

describe('memberOutcome', () => {
  const signupAt = d('2026-01-01T09:00:00Z');
  const credit = (at: string, reversed = false): LedgerPayment => ({ kind: 'credit', at: d(at), reversed });
  const ledger = (payments: LedgerPayment[], orgBuyerAt: Date | null = null): PaymentLedger => ({
    payments,
    orgBuyerAt,
  });
  const opts = (now: string) => ({ windowDays: 30, followUpDays: 30, now: d(now) });

  it('keeps a refunded buyer converted but not retained', () => {
    const outcome = memberOutcome(
      signupAt,
      ledger([credit('2026-01-05T00:00:00Z', true)]),
      opts('2026-06-01T00:00:00Z')
    );
    expect(outcome).toMatchObject({ mature: true, firstPaid: { kind: 'credit', both: false }, retained: false });
  });

  it('marks a buyer still inside the window as immature', () => {
    const outcome = memberOutcome(signupAt, ledger([credit('2026-01-05T00:00:00Z')]), opts('2026-01-20T00:00:00Z'));
    expect(outcome).toMatchObject({ mature: false, firstPaid: { kind: 'credit' }, followUp: null });
  });

  it('withholds follow-up until it has passed, then counts a repeat credit buyer', () => {
    const payments = [credit('2026-01-05T00:00:00Z'), credit('2026-01-20T00:00:00Z')];
    expect(memberOutcome(signupAt, ledger(payments), opts('2026-02-03T00:00:00Z')).followUp).toBeNull();
    expect(memberOutcome(signupAt, ledger(payments), opts('2026-02-05T00:00:00Z')).followUp).toEqual({
      repeatCredit: true,
      renewal: null,
    });
  });

  it('does not count a reversed second purchase or one after the follow-up as a repeat', () => {
    const now = opts('2026-06-01T00:00:00Z');
    expect(
      memberOutcome(signupAt, ledger([credit('2026-01-05T00:00:00Z'), credit('2026-01-06T00:00:00Z', true)]), now)
        .followUp?.repeatCredit
    ).toBe(false);
    expect(
      memberOutcome(
        signupAt,
        ledger([
          credit('2026-01-05T00:00:00Z'),
          credit(new Date(Date.parse('2026-01-05T00:00:00Z') + 31 * DAY).toISOString()),
        ]),
        now
      ).followUp?.repeatCredit
    ).toBe(false);
  });

  it('ignores payments after the window and flags an org purchase inside it', () => {
    const outcome = memberOutcome(
      signupAt,
      ledger([credit('2026-03-01T00:00:00Z')], d('2026-01-10T00:00:00Z')),
      opts('2026-06-01T00:00:00Z')
    );
    expect(outcome).toMatchObject({ firstPaid: null, orgBuyer: true, retained: false, followUp: null });
  });
});

describe('activationStep', () => {
  const signupAt = d('2026-01-01T09:00:00Z');
  const now = d('2026-01-08T09:00:00Z');

  it('leaves a signup younger than the funnel minimum age unjudged', () => {
    expect(activationStep(signupAt, ['2026-01-01'], d('2026-01-08T08:59:59Z'))).toBeNull();
  });

  it('applies the funnel first-week rules', () => {
    expect(activationStep(signupAt, [], now)).toBe('signedUp');
    expect(activationStep(signupAt, ['2026-01-09'], now)).toBe('signedUp');
    expect(activationStep(signupAt, ['2026-01-01'], now)).toBe('firstAction');
    expect(activationStep(signupAt, ['2026-01-01', '2026-01-08'], now)).toBe('cameBack');
  });
});
