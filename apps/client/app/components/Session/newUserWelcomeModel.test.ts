import { describe, it, expect } from 'vitest';
import {
  STARTER_PROMPTS,
  activeTimeCopy,
  advertisedDripCredits,
  shouldShowNewUserWelcome,
  unlockPathsCopy,
  welcomeCreditsLine,
} from './newUserWelcomeModel';

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

  it('names every unlock path and the daily drip amount for a staged tranche', () => {
    expect(
      welcomeCreditsLine({
        ...base,
        awaitingVerification: true,
        pendingGrant: 1000,
        pendingGrantIsMaximum: true,
        dailyDripCredits: 1000,
      })
    ).toBe(
      'Verify your email to unlock up to 1,000 credits now. The rest unlocks up to 1,000 credits for each day you have Bike4Mind open and in use for about 1 minute (a hidden tab or 5 minutes without input does not count), all at once when you subscribe, or all at once when you verify a card.'
    );
  });

  it('omits the daily drip clause when the drip is off', () => {
    const line = welcomeCreditsLine({
      ...base,
      awaitingVerification: true,
      pendingGrant: 1000,
      pendingGrantIsMaximum: true,
    });
    expect(line).toContain('when you subscribe');
    expect(line).not.toContain('each day');
    expect(line).not.toContain('eligibility');
  });
});

describe('STARTER_PROMPTS', () => {
  it('offers three distinct, ASCII-only prompts', () => {
    expect(STARTER_PROMPTS).toHaveLength(3);
    expect(new Set(STARTER_PROMPTS.map(p => p.prompt)).size).toBe(3);
    for (const p of STARTER_PROMPTS) expect(p.prompt).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('activeTimeCopy', () => {
  it.each([
    [undefined, 'about 1 minute'],
    ['junk', 'about 1 minute'],
    [0, 'about 1 minute'],
    [600, 'about 10 minutes'],
    [900, 'about 15 minutes'],
    [3600, 'about 1 hour'],
    [5400, 'about 1.5 hours'],
    [7200, 'about 2 hours'],
  ])('renders %s as %s', (seconds, expected) => {
    expect(activeTimeCopy(seconds)).toBe(expected);
  });

  it('feeds the unlock paths copy from the setting', () => {
    expect(unlockPathsCopy(500, '1800')).toContain('for about 30 minutes');
  });
});

describe('advertisedDripCredits', () => {
  const on = { dailyCredits: 1000, dripCap: 9000 };
  it('advertises the daily amount while the cap leaves at least that much', () => {
    expect(advertisedDripCredits({ ...on, grant: { dripCredits: 3000 } })).toBe(1000);
  });

  it('advertises only what the cap still leaves when that is below the daily amount', () => {
    expect(advertisedDripCredits({ dailyCredits: 1000, dripCap: 400, grant: {} })).toBe(400);
    expect(advertisedDripCredits({ ...on, grant: { dripCredits: 8500 } })).toBe(500);
  });

  it('advertises nothing once the account has dripped up to or past the cap', () => {
    expect(advertisedDripCredits({ ...on, grant: { dripCredits: 9000 } })).toBe(0);
    expect(advertisedDripCredits({ ...on, grant: { dripCredits: 9500 } })).toBe(0);
    expect(advertisedDripCredits({ ...on, dripCap: 0, grant: {} })).toBe(0);
  });

  it('treats an absent grant as nothing dripped yet', () => {
    expect(advertisedDripCredits({ ...on, grant: undefined })).toBe(1000);
  });

  it('stays off when no daily amount is set', () => {
    expect(advertisedDripCredits({ dailyCredits: 0, dripCap: 9000, grant: {} })).toBe(0);
  });
});
