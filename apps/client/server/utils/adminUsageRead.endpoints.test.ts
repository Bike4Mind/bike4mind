import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const guards: ((req: Request, res: Response, next: () => void) => unknown)[] = [];
    let endpoint: (req: Request, res: Response) => unknown;
    const chain = async (req: Request, res: Response) => {
      for (const guard of guards) await guard(req, res, () => {});
      return endpoint(req, res);
    };
    chain.use = (guard: (typeof guards)[number]) => {
      guards.push(guard);
      return chain;
    };
    chain.get = (handler: typeof endpoint) => {
      endpoint = handler;
      return chain;
    };
    return chain;
  },
}));
const mocks = vi.hoisted(() => ({
  organization: vi.fn(),
  ledger: vi.fn(),
  usage: vi.fn(),
  belongs: vi.fn(),
  executions: vi.fn(),
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById: mocks.organization } }));
vi.mock('@bike4mind/database', () => ({
  creditTransactionRepository: { queryLedgerPage: mocks.ledger },
  usageEventRepository: { sessionUsageSummary: mocks.usage, sessionBelongsToOwner: mocks.belongs },
  agentExecutionRepository: { findBillingBySessionId: mocks.executions },
}));
vi.mock('@server/utils/resolveUserNames', () => ({ resolveUserNames: async () => new Map() }));
import transactions from '../../pages/api/admin/transactions';
import sessionUsage from '../../pages/api/admin/session-usage';

const OWN_ORG = '6650000000000000000000aa';
const OTHER_ORG = '6650000000000000000000bb';
const samples = [
  { name: 'transactions', handler: transactions, query: {} },
  { name: 'session usage', handler: sessionUsage, query: { sessionId: 'session-1' } },
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.organization.mockImplementation(async (id: string) => ({
    id,
    userId: id === OWN_ORG ? 'owner' : 'someone-else',
  }));
  mocks.ledger.mockResolvedValue({ data: [], total: 0 });
  mocks.usage.mockResolvedValue({ byQuest: [], byModel: [], totals: {} });
  mocks.belongs.mockResolvedValue(true);
  mocks.executions.mockResolvedValue([]);
});
const call = async (sample: (typeof samples)[number], organizationId: string, adminPermissions: string[] = []) => {
  const { req, res } = createMocks<Request, Response>({ method: 'GET', query: { ...sample.query, organizationId } });
  req.user = { id: 'owner', isAdmin: false, adminPermissions } as Request['user'];
  await (sample.handler as unknown as (req: Request, res: Response) => Promise<unknown>)(req, res);
  return res._getJSONData() as unknown;
};
describe('organization owner billing reads through admin routes', () => {
  it.each(samples)('$name permits an ordinary owner only for their own organization', async sample => {
    await expect(call(sample, OWN_ORG)).resolves.toBeDefined();
    vi.clearAllMocks();
    await expect(call(sample, OTHER_ORG)).rejects.toThrow('Organization not found');
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(mocks.usage).not.toHaveBeenCalled();
  });
  it.each(samples)('$name permits support reads across organizations', async sample => {
    await expect(call(sample, OTHER_ORG, ['support:read'])).resolves.toBeDefined();
  });
  it('retains the ordinary owner session filter while support reads the full session', async () => {
    const sample = samples[1];
    await call(sample, OWN_ORG);
    expect(mocks.usage).toHaveBeenLastCalledWith('session-1', { ownerId: OWN_ORG, ownerType: 'Organization' });
    await call(sample, OTHER_ORG, ['support:read']);
    expect(mocks.usage).toHaveBeenLastCalledWith('session-1', undefined);
  });
});
