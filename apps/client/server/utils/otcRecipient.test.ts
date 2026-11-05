import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  shouldBlock: vi.fn(),
  acceptsMail: vi.fn(),
  cache: new Map<string, unknown>(),
}));
vi.mock('@bike4mind/services', () => ({
  userService: { shouldBlockDisposableEmail: mocks.shouldBlock, domainAcceptsMail: mocks.acceptsMail },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: {
    findByKey: async (key: string) => (mocks.cache.has(key) ? { result: mocks.cache.get(key) } : null),
    createOrUpdate: async ({ key, result }: { key: string; result: unknown }) => mocks.cache.set(key, result),
  },
}));
vi.mock('@server/auth/signupProtection', () => ({ signupProtection: {} }));

import { otcRecipientRefusal } from './otcRecipient';

const logger = { warn: vi.fn() } as never;

describe('otcRecipientRefusal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cache.clear();
    mocks.shouldBlock.mockResolvedValue(false);
    mocks.acceptsMail.mockResolvedValue(true);
  });

  it('refuses a blocked or disposable domain before any DNS lookup', async () => {
    mocks.shouldBlock.mockResolvedValue(true);
    expect(await otcRecipientRefusal('a@burner.example', logger)).toBe('blocked-domain');
    expect(mocks.acceptsMail).not.toHaveBeenCalled();
  });

  it('refuses a domain that cannot receive mail, and caches the answer', async () => {
    mocks.acceptsMail.mockResolvedValue(false);
    expect(await otcRecipientRefusal('a@nowhere.example', logger)).toBe('no-mail-host');
    expect(await otcRecipientRefusal('b@nowhere.example', logger)).toBe('no-mail-host');
    expect(mocks.acceptsMail).toHaveBeenCalledExactlyOnceWith('nowhere.example', { timeoutMs: 2000 });
  });

  it('delivers when DNS is undecided, without caching', async () => {
    mocks.acceptsMail.mockResolvedValue(undefined);
    expect(await otcRecipientRefusal('a@flaky.example', logger)).toBeUndefined();
    expect(await otcRecipientRefusal('a@flaky.example', logger)).toBeUndefined();
    expect(mocks.acceptsMail).toHaveBeenCalledTimes(2);
  });

  it('skips the DNS lookup for personal mail providers', async () => {
    expect(await otcRecipientRefusal('a@gmail.com', logger)).toBeUndefined();
    expect(mocks.acceptsMail).not.toHaveBeenCalled();
  });

  it('fails open when a check throws', async () => {
    mocks.shouldBlock.mockRejectedValue(new Error('settings unavailable'));
    expect(await otcRecipientRefusal('a@example.org', logger)).toBeUndefined();
  });
});
