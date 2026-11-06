import { describe, it, expect, vi, beforeEach } from 'vitest';
import { newSignupGrant, settingsMap } from '@bike4mind/common';

const findBySettingNames = vi.fn();
type Row = { settingName: string; settingValue: unknown };
// Return only the requested rows, so a setting dropped from the query reads as unset.
const stored = (all: Row[]) =>
  findBySettingNames.mockImplementation(async (names: string[]) => all.filter(r => names.includes(r.settingName)));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingNames: (...args: unknown[]) => findBySettingNames(...args) },
}));

import { getOpenSignupStarterCredits } from './starterCredits';

const rows = (openReg: unknown, freeCredits: unknown): Row[] => [
  { settingName: 'allowOpenRegistration', settingValue: openReg },
  { settingName: 'defaultFreeCredits', settingValue: freeCredits },
];

describe('getOpenSignupStarterCredits', () => {
  beforeEach(() => {
    findBySettingNames.mockReset();
  });

  it('returns the initial grant when open registration is on, in one query', async () => {
    stored([...rows(true, 5000), { settingName: 'signupGrantInitialCredits', settingValue: 700 }]);

    await expect(getOpenSignupStarterCredits()).resolves.toBe(700);
    expect(findBySettingNames).toHaveBeenCalledTimes(1);
  });

  it('returns 0 on an invite-only deployment', async () => {
    stored(rows(false, 5000));

    await expect(getOpenSignupStarterCredits()).resolves.toBe(0);
  });

  it('returns 0 when neither setting is stored (open registration defaults off)', async () => {
    stored([]);

    await expect(getOpenSignupStarterCredits()).resolves.toBe(0);
  });

  it('returns the signup tranche while the initial grant is unset, still in one query', async () => {
    stored([
      ...rows(true, 5000),
      { settingName: 'stagedSignupGrantEnabled', settingValue: true },
      { settingName: 'signupGrantCredits', settingValue: 250 },
    ]);

    await expect(getOpenSignupStarterCredits()).resolves.toBe(250);
    expect(findBySettingNames).toHaveBeenCalledTimes(1);
    expect(findBySettingNames.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['signupGrantCredits', 'signupGrantInitialCredits'])
    );
  });

  it('never advertises the retired defaultFreeCredits', async () => {
    stored([...rows(true, 5000), { settingName: 'stagedSignupGrantEnabled', settingValue: 'false' }]);

    await expect(getOpenSignupStarterCredits()).resolves.toBe(0);
  });

  it('returns 0 when staged grants are on and neither signupGrantCredits nor defaultFreeCredits is stored', async () => {
    stored([
      { settingName: 'allowOpenRegistration', settingValue: true },
      { settingName: 'stagedSignupGrantEnabled', settingValue: true },
    ]);

    await expect(getOpenSignupStarterCredits()).resolves.toBe(0);
  });

  it('returns 0 when staged grants are on with a zero tranche', async () => {
    stored([
      ...rows(true, 5000),
      { settingName: 'stagedSignupGrantEnabled', settingValue: true },
      { settingName: 'signupGrantCredits', settingValue: 0 },
    ]);

    await expect(getOpenSignupStarterCredits()).resolves.toBe(0);
  });

  it('ignores the retired staged toggle', async () => {
    stored([
      ...rows(true, 5000),
      { settingName: 'stagedSignupGrantEnabled', settingValue: false },
      { settingName: 'signupGrantCredits', settingValue: 250 },
    ]);

    await expect(getOpenSignupStarterCredits()).resolves.toBe(250);
  });

  it('returns 0 on an invite-only deployment even with staged grants on', async () => {
    stored([
      ...rows(false, 5000),
      { settingName: 'stagedSignupGrantEnabled', settingValue: true },
      { settingName: 'signupGrantCredits', settingValue: 250 },
    ]);

    await expect(getOpenSignupStarterCredits()).resolves.toBe(0);
  });

  // The share page has no invite code to read, so a visitor is offered what an uninvited signup gets.
  it('advertises the initial grant alone, without the drip cap or the invite bonus', async () => {
    stored([
      ...rows(true, 5000),
      { settingName: 'signupGrantInitialCredits', settingValue: 1000 },
      { settingName: 'signupGrantDripCap', settingValue: 9000 },
      { settingName: 'signupGrantInviteBonusCredits', settingValue: 2000 },
    ]);

    await expect(getOpenSignupStarterCredits()).resolves.toBe(1000);
  });

  it('returns 0 on an invite-only deployment even with an initial grant and invite bonus set', async () => {
    stored([
      ...rows(false, 5000),
      { settingName: 'signupGrantInitialCredits', settingValue: 1000 },
      { settingName: 'signupGrantInviteBonusCredits', settingValue: 2000 },
    ]);

    await expect(getOpenSignupStarterCredits()).resolves.toBe(0);
  });

  // Parity with the real grant: `newSignupGrant` reads the full stored set, not just the queried names, so a
  // setting it starts reading that STARTER_CREDIT_SETTINGS lacks shows up here as a mismatch once seeded.
  it.each([
    { staged: true, tranche: 250, free: 5000 },
    { staged: 'true', tranche: undefined, free: 5000 },
    { staged: true, tranche: 0, free: 5000 },
    { staged: false, tranche: 250, free: 5000 },
    { staged: undefined, tranche: 250, free: 1200 },
    { staged: true, tranche: 250, free: 5000, initial: 1000 },
    { staged: undefined, tranche: undefined, free: 5000, initial: 0 },
  ])(
    'matches what an open signup is granted ($staged, $tranche, $free, $initial)',
    async ({
      staged,
      tranche,
      free,
      initial,
    }: {
      staged: unknown;
      tranche?: number;
      free: number;
      initial?: number;
    }) => {
      const all: Row[] = [
        ...rows(true, free),
        { settingName: 'verifiedUnlockCredits', settingValue: 4750 },
        { settingName: 'signupGrantDripCap', settingValue: 9000 },
        { settingName: 'signupGrantInviteBonusCredits', settingValue: 2000 },
        ...(initial === undefined ? [] : [{ settingName: 'signupGrantInitialCredits', settingValue: initial }]),
        ...(staged === undefined ? [] : [{ settingName: 'stagedSignupGrantEnabled', settingValue: staged }]),
        ...(tranche === undefined ? [] : [{ settingName: 'signupGrantCredits', settingValue: tranche }]),
      ];
      stored(all);
      const repo = {
        findBySettingName: async (name: string) => all.find(r => r.settingName === name) ?? null,
      } as Parameters<typeof newSignupGrant>[0];
      const flat = settingsMap.defaultFreeCredits.schema.parse(free);

      await expect(getOpenSignupStarterCredits()).resolves.toBe((await newSignupGrant(repo))?.signupCredits ?? flat);
    }
  );

  it('returns 0 when the lookup fails', async () => {
    findBySettingNames.mockRejectedValue(new Error('db down'));

    await expect(getOpenSignupStarterCredits()).resolves.toBe(0);
  });
});
