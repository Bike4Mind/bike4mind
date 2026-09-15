import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Mock only the repositories; settingsMap (zod parsing) stays real so the
// boolean/string/missing setting-value handling is exercised for real.
const mockFindBySettingName = vi.fn();
const mockUserCount = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    findBySettingName: (...a: unknown[]) => mockFindBySettingName(...a),
  },
  userRepository: {
    count: (...a: unknown[]) => mockUserCount(...a),
  },
}));

// Strip the middleware chain (DB connect, logging) the same way otc-verify.test.ts does,
// so the test exercises the route logic itself.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (handler: (...a: unknown[]) => unknown) => handler;
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));

describe('/api/settings/serverConfigPublic — self-host first-user bootstrap', () => {
  let handler: (req: unknown, res: unknown) => Promise<unknown>;
  const originalSelfHost = process.env.B4M_SELF_HOST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFindBySettingName.mockResolvedValue(null); // no persisted setting -> default (false)
    const mod = await import('@pages/api/settings/serverConfigPublic');
    handler = mod.default as typeof handler;
  });

  afterEach(() => {
    if (originalSelfHost === undefined) {
      delete process.env.B4M_SELF_HOST;
    } else {
      process.env.B4M_SELF_HOST = originalSelfHost;
    }
  });

  const run = async () => {
    const { req, res } = createMocks({ method: 'GET', headers: { host: 'localhost:3000' } });
    await handler(req, res);
    return JSON.parse(res._getData()) as { allowOpenRegistration: boolean };
  };

  it('reports closed registration outside self-host even with zero users', async () => {
    delete process.env.B4M_SELF_HOST;
    mockUserCount.mockResolvedValue(0);

    const body = await run();

    expect(body.allowOpenRegistration).toBe(false);
    // The user count must not even be consulted outside self-host.
    expect(mockUserCount).not.toHaveBeenCalled();
  });

  it('opens the bootstrap window on a fresh self-host install (zero users)', async () => {
    process.env.B4M_SELF_HOST = 'true';
    mockUserCount.mockResolvedValue(0);

    const body = await run();

    expect(body.allowOpenRegistration).toBe(true);
  });

  it('closes the window again once the first self-host account exists', async () => {
    process.env.B4M_SELF_HOST = 'true';
    mockUserCount.mockResolvedValue(1);

    const body = await run();

    expect(body.allowOpenRegistration).toBe(false);
  });

  it('honors an explicitly enabled allowOpenRegistration setting without counting users', async () => {
    process.env.B4M_SELF_HOST = 'true';
    mockFindBySettingName.mockResolvedValue({ settingValue: true });

    const body = await run();

    expect(body.allowOpenRegistration).toBe(true);
    expect(mockUserCount).not.toHaveBeenCalled();
  });
});
