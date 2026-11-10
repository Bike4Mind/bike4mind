import { describe, expect, it } from 'vitest';
import {
  describeNewAccountGrant,
  dripCapWarning,
  inviteBonusWarning,
  readScheduleValues,
  type ScheduleValues,
} from './scheduleSummary';

const read = (rows: Record<string, unknown>) => readScheduleValues(new Map(Object.entries(rows)));
const live: Record<string, unknown> = {
  signupGrantInitialCredits: 1000,
  signupGrantDailyCredits: 100,
  signupGrantDripCap: 5000,
  signupGrantSignupPoolDaily: 50000,
  signupGrantTricklePoolDaily: 20000,
};

describe('readScheduleValues', () => {
  it('resolves rows as the server does: numeric strings as numbers, unset and invalid rows as the fallback', () => {
    const values = read({
      signupGrantInitialCredits: '250',
      signupGrantDailyCredits: 'abc',
      signupGrantDripCap: -1,
      signupGrantInviteBonusCredits: true,
      signupGrantSignupPoolDaily: 'abc',
    });
    expect(values.signupGrantInitialCredits).toBe(250);
    expect(values.signupGrantDailyCredits).toBe(0);
    expect(values.signupGrantDripCap).toBe(0);
    expect(values.signupGrantInviteBonusCredits).toBe(0);
    expect(values.signupGrantSignupPoolDaily).toBe(0);
    expect(values.signupGrantTricklePoolDaily).toBe(0);
  });

  it('reads a cleared field as the default rather than an invalid row', () => {
    expect(read({ signupGrantDripCap: '' }).signupGrantDripCap).toBe(0);
    expect(read({ signupGrantTricklePoolDaily: ' ' }).signupGrantTricklePoolDaily).toBe(0);
  });
});

describe('describeNewAccountGrant', () => {
  it('describes the initial grant and the drip with both pools funded', () => {
    expect(describeNewAccountGrant(read(live))).toBe(
      'New accounts get 1,000 credits after verification, then 100 credits per active day up to 5,000 credits.'
    );
  });

  it.each([
    ['unset cap', { signupGrantDripCap: undefined }],
    ['zero cap', { signupGrantDripCap: 0 }],
    ['zero daily', { signupGrantDailyCredits: 0 }],
    ['invalid daily', { signupGrantDailyCredits: 'abc' }],
  ])('reports no drip for a %s', (_label, override) => {
    expect(describeNewAccountGrant(read({ ...live, ...override }))).toContain(', with no daily drip.');
  });

  it('adds the invite bonus only when it is above 0', () => {
    expect(describeNewAccountGrant(read({ ...live, signupGrantInviteBonusCredits: 500 }))).toContain(
      'Invited accounts get 500 credits more.'
    );
    expect(describeNewAccountGrant(read({ ...live, signupGrantInviteBonusCredits: 0 }))).not.toContain('Invited');
  });

  it.each([
    ['signupGrantSignupPoolDaily', 0, 'signup pool'],
    ['signupGrantSignupPoolDaily', 'abc', 'signup pool'],
    ['signupGrantTricklePoolDaily', 0, 'trickle pool'],
    ['signupGrantTricklePoolDaily', undefined, 'trickle pool'],
  ])('says grants are paused when %s is %j', (key, value, pool) => {
    const summary = describeNewAccountGrant(read({ ...live, [key]: value }));
    expect(summary).toContain(`Paused: the ${pool} has no daily budget`);
  });

  it('says activity grants are skipped, not held, when the trickle pool is paused', () => {
    expect(describeNewAccountGrant(read({ ...live, signupGrantTricklePoolDaily: 0 }))).toContain(
      'so daily activity grants are skipped and rewards are held.'
    );
  });

  it('does not mention skipped activity grants when nothing drips', () => {
    const summary = describeNewAccountGrant(
      read({ ...live, signupGrantDailyCredits: 0, signupGrantTricklePoolDaily: 0 })
    );
    expect(summary).toContain('Paused: the trickle pool has no daily budget, so rewards are held.');
    expect(summary).not.toContain('skipped');
  });
});

describe('dripCapWarning', () => {
  const values = (daily: unknown, dripCap: unknown): ScheduleValues =>
    read({ signupGrantDailyCredits: daily, signupGrantDripCap: dripCap });

  it.each([
    [100, 50, true],
    [100, 100, false],
    [100, 500, false],
    [100, 0, false],
    [0, 50, false],
    [100, undefined, false],
    ['abc', 50, false],
  ])('daily %j with cap %j warns: %s', (daily, dripCap, expected) => {
    expect(dripCapWarning(values(daily, dripCap))).toBe(expected);
  });
});

describe('inviteBonusWarning', () => {
  it.each([
    [500, false, true],
    [500, true, false],
    [0, false, false],
    [undefined, false, false],
  ])('bonus %j with send limits live %s warns: %s', (bonus, sendLimitsLive, expected) => {
    expect(inviteBonusWarning(read({ signupGrantInviteBonusCredits: bonus }), sendLimitsLive)).toBe(expected);
  });
});
