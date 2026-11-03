import { describe, expect, it } from 'vitest';
import { newSignupGrant, resolveSignupGrantSettings } from './signupGrant';

const settings = (values: Record<string, unknown>) =>
  ({
    findBySettingName: async (name: string) => (name in values ? { settingValue: values[name] } : null),
  }) as unknown as Parameters<typeof newSignupGrant>[0];

describe('signup grant configuration', () => {
  it('does not enroll accounts unless explicitly enabled', async () => {
    expect(await newSignupGrant(settings({ defaultFreeCredits: '75' }))).toBeUndefined();
  });

  it.each(['0', '75', '-1', 'invalid'])(
    'preserves a restricted legacy setting %s without adding an unlock',
    async value => {
      const result = await resolveSignupGrantSettings(settings({ defaultFreeCredits: value }));
      expect(result.signupCredits).toBe(value === '75' ? 75 : 0);
      expect(result.unlockCredits).toBe(0);
    }
  );

  it('honors explicit zero instead of falling back to the legacy grant', async () => {
    const result = await newSignupGrant(
      settings({
        stagedSignupGrantEnabled: 'true',
        defaultFreeCredits: '75',
        signupGrantCredits: '0',
        verifiedUnlockCredits: '25',
      })
    );
    expect(result).toEqual({
      stage: 'pending_email',
      signupCredits: 0,
      unlockCredits: 25,
      creditsReleased: 0,
      nextCondition: 'email_verification',
    });
  });
});
