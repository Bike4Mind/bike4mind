import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, ELEVENLABS_DEFAULT_DURATION_SECONDS, type IProviderUnitsRow } from '@bike4mind/common';

// Same harness as usage-margin.test.ts: captures the config so the ADMIN scope gate can be asserted.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const middlewares: ((req: unknown, res: unknown, next: () => void) => unknown)[] = [];
    const chain = async (req: { method: string }, res: unknown) => {
      for (const middleware of middlewares) await middleware(req, res, () => undefined);
      return handlers[req.method](req, res);
    };
    chain.use = (middleware: (typeof middlewares)[number]) => {
      middlewares.push(middleware);
      return chain;
    };
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    chain._config = config;
    return chain;
  },
}));

const mockBreakdown = vi.fn();
const mockFindByIds = vi.fn();
const mockSettings = vi.fn();
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: { providerUnitsBreakdown: (...a: unknown[]) => mockBreakdown(...a) },
  userRepository: { findByIds: (...a: unknown[]) => mockFindByIds(...a) },
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: () => mockSettings(),
}));

import handler from '../elevenlabs-usage';

function call(options: { isAdmin?: boolean; query?: object } = {}) {
  const { req, res } = createMocks({ method: 'GET', query: options.query ?? {} });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
  };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

const row: IProviderUnitsRow = {
  day: '2026-03-16',
  feature: 'text_to_speech',
  model: 'eleven_multilingual_v2',
  userId: 'u1',
  keySource: 'platform',
  status: 'ok',
  atDefaultUnits: false,
  requests: 2,
  units: 500,
};

describe('GET /api/admin/elevenlabs-usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-20T12:00:00Z'));
    mockBreakdown.mockResolvedValue([row]);
    mockFindByIds.mockResolvedValue([{ id: 'u1', name: 'Ada' }]);
    mockSettings.mockResolvedValue({
      elevenLabsPlanCycleStartDay: '15',
      elevenLabsPlanMonthlyCredits: '100000',
      elevenLabsPlanAgentMinutes: '0',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires the ADMIN scope on the API-key path', () => {
    const config = (handler as unknown as { _config?: { requiredScopes?: string[] } })._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects a non-admin', async () => {
    await expect(call({ isAdmin: false }).run()).rejects.toThrow(/missing permission/i);
    expect(mockBreakdown).not.toHaveBeenCalled();
  });

  it('summarizes the current cycle from the configured start day, with user labels', async () => {
    const { res, run } = call();
    await run();

    expect(mockBreakdown).toHaveBeenCalledWith({
      provider: 'elevenlabs',
      from: new Date('2026-03-15T00:00:00Z'),
      to: new Date('2026-04-15T00:00:00Z'),
      defaultUnits: ELEVENLABS_DEFAULT_DURATION_SECONDS,
    });
    const body = res._getJSONData();
    expect(body.plan).toEqual({ monthlyCredits: 100000, agentMinutes: null });
    expect(body.platform).toMatchObject({ requests: 2, credits: 500 });
    expect(body.byUser).toEqual([expect.objectContaining({ userId: 'u1', userLabel: 'Ada', credits: 500 })]);
  });

  it('reads an earlier cycle', async () => {
    await call({ query: { cyclesBack: '1' } }).run();

    expect(mockBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ from: new Date('2026-02-15T00:00:00Z'), to: new Date('2026-03-15T00:00:00Z') })
    );
  });

  it.each(['-1', '13', '1.5', 'abc'])('rejects cyclesBack=%s', async cyclesBack => {
    await expect(call({ query: { cyclesBack } }).run()).rejects.toThrow(/cyclesBack/);
  });
});
