import { describe, it, expect } from 'vitest';
import { NO_CARD_UNLOCK_REASONS, noCardUnlockTransactionId, resolveNoCardUnlockSettings } from './noCardUnlock';

describe('noCardUnlockTransactionId', () => {
  it('is per reason and user', () => {
    expect(noCardUnlockTransactionId('github_verified', 'u1')).toBe('unlock-grant:github_verified:u1');
    expect(NO_CARD_UNLOCK_REASONS).toEqual(['github_verified', 'work_email_verified']);
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
