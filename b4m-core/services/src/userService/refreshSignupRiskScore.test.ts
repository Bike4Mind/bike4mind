import { describe, it, expect, vi, beforeEach } from 'vitest';
import { settingsMap, type ISignupRiskScore } from '@bike4mind/common';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { refreshSignupRiskScore, type RefreshSignupRiskScoreAdapters } from './refreshSignupRiskScore';

const SIGNED_UP = new Date('2026-10-20T10:00:00Z');
const NOW = new Date('2026-10-21T10:00:00Z');
const WEIGHTS = settingsMap.signupRiskScoring.defaultValue.weights;

const setup = ({
  user = {},
  firstKeyAt = null as Date | null,
  spent = 0,
  settings = {} as Record<string, unknown>,
} = {}) => {
  const setRiskScore = vi.fn(async (_userId: string, _riskScore: ISignupRiskScore) => undefined);
  const creditsSpentByUser = vi.fn(async () => spent);
  const warn = vi.fn();
  const adapters: RefreshSignupRiskScoreAdapters = {
    db: {
      users: {
        findById: vi.fn(async (id: string) =>
          id === 'gone' ? null : { id, email: 'jane.doe@example.com', createdAt: SIGNED_UP, ...user }
        ),
        setRiskScore,
      } as unknown as RefreshSignupRiskScoreAdapters['db']['users'],
      userApiKeys: { findFirstCreatedAtByUserId: vi.fn(async () => firstKeyAt) },
      usageEvents: { creditsSpentByUser },
      adminSettings: {
        findAll: vi.fn(async () =>
          Object.entries(settings).map(([settingName, settingValue]) => ({ settingName, settingValue }))
        ),
        findBySettingNames: vi.fn(async (names: string[]) =>
          names.filter(n => n in settings).map(n => ({ settingName: n, settingValue: settings[n] }))
        ),
        findBySettingName: vi.fn(async (name: string) =>
          name in settings ? { settingName: name, settingValue: settings[name] } : null
        ),
      } as unknown as RefreshSignupRiskScoreAdapters['db']['adminSettings'],
    },
    logger: { warn },
    now: NOW,
  };
  const stored = () => setRiskScore.mock.calls[0]?.[1];
  return { adapters, setRiskScore, creditsSpentByUser, warn, stored };
};

describe('refreshSignupRiskScore', () => {
  // getSettingsMap caches per process; each case stores its own settings.
  beforeEach(() => invalidateSettingsCache());

  it('stores a zero score with state none for an account with no signals', async () => {
    const { adapters, setRiskScore } = setup();

    await refreshSignupRiskScore('u1', adapters);

    expect(setRiskScore).toHaveBeenCalledWith('u1', { score: 0, signals: [], computedAt: NOW, reviewState: 'none' });
  });

  it('measures the first key and the first-day spend from the signup time', async () => {
    const { adapters, creditsSpentByUser, stored } = setup({
      firstKeyAt: new Date(SIGNED_UP.getTime() + 10 * 60 * 1000),
      spent: 400,
    });

    await refreshSignupRiskScore('u1', adapters);

    expect(creditsSpentByUser).toHaveBeenCalledWith('u1', SIGNED_UP, new Date('2026-10-21T10:00:00Z'));
    expect(stored()?.signals.map(s => [s.signal, s.reason])).toEqual([
      ['quickApiKey', 'First API key created 10 minutes after signup'],
      ['fastSpend', '400 credits spent in the first 24 hours'],
    ]);
  });

  it('reads the datacenter flag from the signup metadata', async () => {
    const { adapters, stored } = setup({ user: { signupMeta: { isDatacenter: true } } });

    await refreshSignupRiskScore('u1', adapters);

    expect(stored()?.signals.map(s => s.signal)).toEqual(['datacenterNetwork']);
  });

  it.each([
    ['a disposable domain', 'someone@mailinator.com', {}],
    ['an admin-blocked domain', 'someone@blocked.example', { blockedEmailDomains: ['blocked.example'] }],
    [
      'a disposable domain with the disposable block turned off',
      'someone@mailinator.com',
      { blockDisposableEmails: false },
    ],
  ])('counts %s as a risky domain', async (_label, email, settings) => {
    const { adapters, stored } = setup({ user: { email }, settings });

    await refreshSignupRiskScore('u1', adapters);

    expect(stored()?.signals.map(s => s.signal)).toEqual(['riskyDomain']);
  });

  it('proposes pending at the review threshold, using the stored scoring setting', async () => {
    const { adapters, stored } = setup({
      user: { email: 'someone@mailinator.com', signupMeta: { isDatacenter: true } },
      settings: {
        signupRiskScoring: JSON.stringify({ reviewThreshold: WEIGHTS.riskyDomain + WEIGHTS.datacenterNetwork }),
      },
    });

    await refreshSignupRiskScore('u1', adapters);

    expect(stored()).toMatchObject({ score: WEIGHTS.riskyDomain + WEIGHTS.datacenterNetwork, reviewState: 'pending' });
  });

  it('proposes pending below the threshold while the signup grant policy holds the tranche for review', async () => {
    const grant = { stage: 'signup', signupCredits: 500, unlockCredits: 500, creditsReleased: 0 };
    const { adapters, stored } = setup({
      user: { signupGrant: grant, signupGrantAssessment: { band: 'review', status: 'evaluated' } },
    });

    await refreshSignupRiskScore('u1', adapters);

    expect(stored()).toMatchObject({ score: 0, reviewState: 'pending' });
  });

  it('leaves state none once the held tranche has been paid', async () => {
    const grant = { stage: 'signup', signupCredits: 500, unlockCredits: 500, creditsReleased: 500 };
    const { adapters, stored } = setup({
      user: { signupGrant: grant, signupGrantAssessment: { band: 'review', status: 'evaluated' } },
    });

    await refreshSignupRiskScore('u1', adapters);

    expect(stored()?.reviewState).toBe('none');
  });

  it('scores an account with no email without a domain signal', async () => {
    const { adapters, stored } = setup({ user: { email: null } });

    await refreshSignupRiskScore('u1', adapters);

    expect(stored()).toMatchObject({ score: 0, reviewState: 'none' });
  });

  it('does nothing for a user that no longer exists', async () => {
    const { adapters, setRiskScore } = setup();

    await refreshSignupRiskScore('gone', adapters);

    expect(setRiskScore).not.toHaveBeenCalled();
  });

  it('logs a failure at warn and never throws', async () => {
    const { adapters, setRiskScore, warn } = setup();
    setRiskScore.mockRejectedValueOnce(new Error('write failed'));

    await expect(refreshSignupRiskScore('u1', adapters)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Signup risk score refresh failed', { userId: 'u1', error: 'write failed' });
  });
});
