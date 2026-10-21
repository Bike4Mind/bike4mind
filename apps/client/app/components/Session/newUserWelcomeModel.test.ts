import { describe, it, expect } from 'vitest';
import { STARTER_PROMPTS, shouldShowNewUserWelcome, welcomeCreditsLine } from './newUserWelcomeModel';

describe('shouldShowNewUserWelcome', () => {
  it('shows only for a loaded, notebook-free, undismissed user', () => {
    expect(shouldShowNewUserWelcome({ sessionsLoaded: true, sessionCount: 0, dismissed: false })).toBe(true);
  });

  it('never shows to a returning user with notebooks', () => {
    expect(shouldShowNewUserWelcome({ sessionsLoaded: true, sessionCount: 3, dismissed: false })).toBe(false);
  });

  it('stays hidden while the notebook list is loading, so returning users never see a flash', () => {
    expect(shouldShowNewUserWelcome({ sessionsLoaded: false, sessionCount: 0, dismissed: false })).toBe(false);
  });

  it('stays hidden once dismissed', () => {
    expect(shouldShowNewUserWelcome({ sessionsLoaded: true, sessionCount: 0, dismissed: true })).toBe(false);
  });
});

describe('welcomeCreditsLine', () => {
  const base = { enforceCredits: true, balance: 9982, awaitingVerification: false, pendingGrant: null };

  it('states the live starting balance', () => {
    expect(welcomeCreditsLine(base)).toMatch(/^You're starting with 9,982 credits\./);
  });

  it('says nothing about credits when they are not enforced', () => {
    expect(welcomeCreditsLine({ ...base, enforceCredits: false })).toBeNull();
  });

  it('says nothing when the balance is empty and nothing is pending', () => {
    expect(welcomeCreditsLine({ ...base, balance: 0 })).toBeNull();
  });

  it('names the amount verification will unlock when it is known', () => {
    expect(welcomeCreditsLine({ ...base, balance: 0, awaitingVerification: true, pendingGrant: 10000 })).toBe(
      'Verify your email to unlock your 10,000 credits.'
    );
  });

  it('falls back to generic unlock copy when the pending amount is unknown', () => {
    expect(welcomeCreditsLine({ ...base, balance: 0, awaitingVerification: true, pendingGrant: 0 })).toBe(
      'Verify your email to unlock your free credits.'
    );
  });
});

describe('STARTER_PROMPTS', () => {
  it('offers three distinct, ASCII-only prompts', () => {
    expect(STARTER_PROMPTS).toHaveLength(3);
    expect(new Set(STARTER_PROMPTS.map(p => p.prompt)).size).toBe(3);
    for (const p of STARTER_PROMPTS) expect(p.prompt).toMatch(/^[\x20-\x7e]+$/);
  });
});
