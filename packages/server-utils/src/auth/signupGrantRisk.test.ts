import type { IUserDocument } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  network: vi.fn(),
  exists: vi.fn(),
  sources: vi.fn(),
  blocked: vi.fn(),
  disposable: vi.fn(),
}));
vi.mock('./signupNetworkSignals', () => ({ createSignupRiskCollector: () => mocks.network }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  disposableDomainRepository: { disposableSources: mocks.sources },
  User: { exists: (filter: unknown) => ({ maxTimeMS: () => mocks.exists(filter) }) },
}));
vi.mock('@bike4mind/services', () => ({
  userService: { isDisposableEmail: mocks.disposable, isAdminBlockedEmailDomain: mocks.blocked },
}));
import { createSignupGrantRiskCollector } from './signupGrantRisk';

const user = (email: string | null, challengeVerified?: true | null) =>
  ({ id: 'user-1', email, signupMeta: { challengeVerified } }) as unknown as IUserDocument;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.network.mockResolvedValue({});
  mocks.exists.mockResolvedValue(null);
  mocks.sources.mockResolvedValue([]);
  mocks.blocked.mockResolvedValue(false);
  mocks.disposable.mockReturnValue(false);
});

describe('grant risk observations', () => {
  it('collects independent email facts even without network metadata', async () => {
    expect(await createSignupGrantRiskCollector()(user('A.li.ce+tag@gmail.com'))).toEqual({
      canonicalEmailCollision: false,
      disposableDomain: false,
      blockedDomain: false,
      challengeVerified: null,
    });
    expect(mocks.exists).toHaveBeenCalledWith({ freeCreditClaimEmail: 'alice@gmail.com', _id: { $ne: 'user-1' } });
  });

  it('includes prior entitlement collisions, refreshed domains, and persisted challenge proof', async () => {
    mocks.network.mockResolvedValue({ datacenter: true, ipSignups: 4 });
    mocks.exists.mockResolvedValue({ _id: 'other-user' });
    mocks.sources.mockResolvedValue(['aggregate']);
    mocks.blocked.mockResolvedValue(true);
    expect(await createSignupGrantRiskCollector()(user('person@sub.example.test', true))).toMatchObject({
      datacenter: true,
      ipSignups: 4,
      canonicalEmailCollision: true,
      disposableDomain: true,
      blockedDomain: true,
      challengeVerified: true,
    });
    expect(mocks.sources).toHaveBeenCalledWith(['sub.example.test', 'example.test']);
  });

  it('also recognizes the bundled disposable list', async () => {
    mocks.disposable.mockReturnValue(true);
    expect(await createSignupGrantRiskCollector()(user('person@example.test'))).toMatchObject({
      disposableDomain: true,
    });
  });

  it('keeps missing email observations unknown', async () => {
    expect(await createSignupGrantRiskCollector()(user(null))).toEqual({ challengeVerified: null });
    expect(mocks.exists).not.toHaveBeenCalled();
  });

  it('propagates failed observation reads so a transient outage remains retryable', async () => {
    mocks.sources.mockRejectedValue(new Error('lookup unavailable'));
    await expect(createSignupGrantRiskCollector()(user('person@example.test'))).rejects.toThrow('lookup unavailable');
  });
});
