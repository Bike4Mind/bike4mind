import { describe, it, expect } from 'vitest';
import {
  NO_CARD_UNLOCK_REASONS,
  isBlockedPhone,
  noCardUnlockTransactionId,
  normalizeE164,
  resolveNoCardUnlockSettings,
} from './noCardUnlock';

describe('noCardUnlockTransactionId', () => {
  it('is per reason and user', () => {
    expect(noCardUnlockTransactionId('github_verified', 'u1')).toBe('unlock-grant:github_verified:u1');
    expect(noCardUnlockTransactionId('phone_verified', 'u1')).toBe('unlock-grant:phone_verified:u1');
    expect(NO_CARD_UNLOCK_REASONS).toEqual(['github_verified', 'work_email_verified', 'phone_verified']);
  });
});

describe('resolveNoCardUnlockSettings', () => {
  it('fails closed when nothing is set', () => {
    expect(resolveNoCardUnlockSettings({})).toEqual({
      enabled: false,
      githubCredits: 0,
      workEmailCredits: 0,
      maxCredits: 0,
      githubMinAgeDays: 0,
      githubMinRepos: 0,
      workEmailDomainDailyCap: 0,
      probeInconclusiveAllows: false,
      phoneEnabled: false,
      phoneCredits: 0,
      phoneBlockedPrefixes: [],
      phoneAsnDailyCap: 50,
      phoneCountryDailyCap: 200,
    });
  });

  it.each([
    ['', 0],
    ['abc', 0],
    [-5, 0],
    ['-5', 0],
    [0, 0],
    [1.5, 0],
    [NaN, 0],
    [null, 0],
    [{}, 0],
    [25, 25],
    ['25', 25],
  ])('parses amount %j as %j', (raw, expected) => {
    expect(resolveNoCardUnlockSettings({ noCardUnlockGithubCredits: raw }).githubCredits).toBe(expected);
  });

  it.each([
    [true, true],
    ['true', true],
    ['TRUE', true],
    ['false', false],
    ['', false],
    [1, false],
    ['yes', false],
    [undefined, false],
  ])('parses flag %j as %j', (raw, expected) => {
    const r = resolveNoCardUnlockSettings({ noCardUnlockEnabled: raw, noCardUnlockProbeInconclusiveAllows: raw });
    expect(r.enabled).toBe(expected);
    expect(r.probeInconclusiveAllows).toBe(expected);
  });
});

describe('normalizeE164', () => {
  it.each([
    ['+14155552671', '+14155552671'],
    ['+1 (415) 555-2671', '+14155552671'],
    ['+44 7911.123456', '+447911123456'],
    ['14155552671', null],
    ['+0123456789', null],
    ['+12345', null],
    ['+1234567890123456', null],
    ['+1415abc2671', null],
    ['', null],
    [12345678, null],
    [undefined, null],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizeE164(raw)).toBe(expected);
  });
});

describe('phone blocked prefixes', () => {
  it('accepts a JSON string or an array and drops malformed entries', () => {
    const fromJson = resolveNoCardUnlockSettings({
      noCardUnlockPhoneBlockedPrefixes: JSON.stringify(['+4479 112', 'abc', '+0', 7, '']),
    });
    expect(fromJson.phoneBlockedPrefixes).toEqual(['+4479112']);
    expect(resolveNoCardUnlockSettings({ noCardUnlockPhoneBlockedPrefixes: ['+1555'] }).phoneBlockedPrefixes).toEqual([
      '+1555',
    ]);
    expect(resolveNoCardUnlockSettings({ noCardUnlockPhoneBlockedPrefixes: '{not json' }).phoneBlockedPrefixes).toEqual(
      []
    );
  });

  it('falls back to the default network caps when unset or zero, and honors a set value', () => {
    expect(resolveNoCardUnlockSettings({ noCardUnlockPhoneAsnDailyCap: 0 }).phoneAsnDailyCap).toBe(50);
    expect(resolveNoCardUnlockSettings({ noCardUnlockPhoneCountryDailyCap: '500' }).phoneCountryDailyCap).toBe(500);
  });

  it('blocks every number under a prefix', () => {
    expect(isBlockedPhone('+447911123456', ['+4479111'])).toBe(true);
    expect(isBlockedPhone('+447911223456', ['+4479111'])).toBe(false);
    expect(isBlockedPhone('+447911123456', [])).toBe(false);
  });
});
