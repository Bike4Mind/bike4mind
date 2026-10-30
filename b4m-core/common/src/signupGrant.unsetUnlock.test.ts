import { describe, expect, it, vi } from 'vitest';
import { newSignupGrant, resolveSignupGrantSettings, VERIFIED_UNLOCK_CREDITS_DEFAULT } from './signupGrant';

const settings = (values: Record<string, unknown>) =>
  ({
    findBySettingName: async (name: string) => (name in values ? { settingValue: values[name] } : null),
  }) as unknown as Parameters<typeof newSignupGrant>[0];

const staged = { stagedSignupGrantEnabled: 'true', signupGrantCredits: '12' };

describe('unset verified unlock credits', () => {
  it.each([
    ['absent', {}],
    ['null', { verifiedUnlockCredits: null }],
    ['empty', { verifiedUnlockCredits: '' }],
    ['whitespace', { verifiedUnlockCredits: '   ' }],
  ])('resolves an %s row as unset', async (_label, row) => {
    expect((await resolveSignupGrantSettings(settings({ ...staged, ...row }))).unlockCredits).toBeUndefined();
  });

  it('resolves a stored 0 as 0, not unset', async () => {
    expect((await resolveSignupGrantSettings(settings({ ...staged, verifiedUnlockCredits: '0' }))).unlockCredits).toBe(
      0
    );
  });

  it('snapshots the same grant with the row absent as with the default stored', async () => {
    const warn = vi.fn();
    const absent = await newSignupGrant(settings(staged), undefined, { warn });
    const stored = await newSignupGrant(
      settings({ ...staged, verifiedUnlockCredits: String(VERIFIED_UNLOCK_CREDITS_DEFAULT) })
    );
    expect(absent).toEqual(stored);
    expect(absent?.unlockCredits).toBe(VERIFIED_UNLOCK_CREDITS_DEFAULT);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not warn when the row is stored or a total is fixed', async () => {
    const warn = vi.fn();
    await newSignupGrant(settings({ ...staged, verifiedUnlockCredits: '0' }), undefined, { warn });
    expect(await newSignupGrant(settings(staged), 30, { warn })).toMatchObject({
      signupCredits: 12,
      unlockCredits: 18,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn when staging is off', async () => {
    const warn = vi.fn();
    expect(await newSignupGrant(settings({}), undefined, { warn })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
