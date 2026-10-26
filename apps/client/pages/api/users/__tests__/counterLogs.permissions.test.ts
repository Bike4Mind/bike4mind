import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';

const effects = vi.hoisted(() => ({
  readCache: vi.fn(),
  writeCache: vi.fn(),
  dailyFind: vi.fn(),
  dailySave: vi.fn(),
  weeklyFind: vi.fn(),
  weeklySave: vi.fn(),
  generateReport: vi.fn(),
  generateInsights: vi.fn(),
  operationsModel: vi.fn(),
  apiKey: vi.fn(),
  facet: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use: () => chain,
      get: (handler: (req: Request, res: Response) => unknown) => handler,
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  CounterLog: { collection: { name: 'counterlogs' }, aggregate: vi.fn() },
  User: { collection: { name: 'users' } },
  DailyReport: { find: effects.dailyFind },
  dailyReportRepository: { upsertReport: effects.dailySave },
  weeklyReportRepository: { findByDateRange: effects.weeklyFind, upsertReport: effects.weeklySave },
  counterLogRepository: {},
  cacheRepository: { findByKey: effects.readCache, createOrUpdate: effects.writeCache },
  convertPipelineForDocumentDB: (value: unknown) => value,
  executeFacetCompatible: effects.facet,
}));
vi.mock('@bike4mind/services', () => ({
  counterService: { generateDailyReport: effects.generateReport, generateAgnosticAiInsights: effects.generateInsights },
}));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: effects.operationsModel },
  getEffectiveApiKeyByBackend: effects.apiKey,
}));
vi.mock('@server/utils/sendMaybeGzip', () => ({
  sendMaybeGzip: (_req: Request, res: Response, value: unknown) => res.json(value),
}));
import handler from '../counterLogs';

beforeEach(() => {
  vi.clearAllMocks();
  effects.readCache.mockResolvedValue({ result: { reports: ['cached report'] } });
  effects.facet.mockResolvedValue([{ rows: [], total: [{ value: 0 }] }]);
});
const call = async (
  query: Record<string, string>,
  user: { isAdmin?: boolean; adminPermissions?: string[] },
  canReadLogs = true
) => {
  const { req, res } = createMocks<Request, Response>({
    method: 'GET',
    query: { startDate: '2026-10-01', endDate: '2026-10-07', ...query },
  });
  req.user = { id: 'actor', ...user } as Request['user'];
  req.ability = { can: () => canReadLogs } as Request['ability'];
  await (handler as unknown as (req: Request, res: Response) => Promise<unknown>)(req, res);
  return res._getJSONData() as unknown;
};
describe('counter log report permission boundary', () => {
  it.each([
    ['report', 'false'],
    ['report', 'true'],
    ['weeklyReport', 'false'],
    ['weeklyReport', 'true'],
  ])(
    'support cannot generate %s with includeInsights=%s or reach cache and report collaborators',
    async (flag, includeInsights) => {
      await expect(call({ [flag]: 'true', includeInsights }, { adminPermissions: ['support:read'] })).rejects.toThrow(
        'Missing permission: settings:manage'
      );
      for (const collaborator of Object.values(effects)) expect(collaborator).not.toHaveBeenCalled();
    }
  );
  it.each(['report', 'weeklyReport'])('full admins retain cached %s access', async flag => {
    await expect(call({ [flag]: 'true' }, { isAdmin: true })).resolves.toEqual({ reports: ['cached report'] });
    expect(effects.readCache).toHaveBeenCalledOnce();
  });
  it.each(['report', 'weeklyReport'])(
    'settings-only managers retain %s access without gaining log reads',
    async flag => {
      await expect(call({ [flag]: 'true' }, { adminPermissions: ['settings:manage'] }, false)).resolves.toEqual({
        reports: ['cached report'],
      });
      await expect(call({}, { adminPermissions: ['settings:manage'] }, false)).rejects.toThrow('Unauthorized');
    }
  );
  it('support retains ordinary log reads', async () => {
    effects.readCache.mockResolvedValue(null);
    await expect(call({}, { adminPermissions: ['support:read'] })).resolves.toMatchObject({ logs: [], total: 0 });
    expect(effects.facet).toHaveBeenCalledOnce();
    expect(effects.operationsModel).not.toHaveBeenCalled();
    expect(effects.generateReport).not.toHaveBeenCalled();
  });
});
