import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  baseApiOptions: undefined as unknown,
  findById: vi.fn(),
  update: vi.fn(),
  clearOrgBudgetAlertCache: vi.fn(),
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, (fn: Handler) => unknown> = {};
  for (const method of ['get', 'put']) {
    chain[method] = (fn: Handler) => {
      mocks.handlers[method] = fn;
      return chain;
    };
  }
  return {
    baseApi: (options: unknown) => {
      mocks.baseApiOptions = options;
      return chain;
    },
  };
});
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: mocks.findById, update: mocks.update },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: mocks.recordAdminActionFromRequest,
}));
vi.mock('@bike4mind/server-utils/organizations/evaluateOrgBudget', () => ({
  clearOrgBudgetAlertCache: mocks.clearOrgBudgetAlertCache,
}));

import '@pages/api/organizations/[id]/alert-settings';

const org = {
  id: 'org1',
  name: 'Acme',
  userId: 'owner1',
  adminUserIds: ['manager1'],
  users: [{ userId: 'manager1' }, { userId: 'member1' }],
  budgetAlerts: null,
};
const valid = { enabled: true, monthlyBudgetCredits: 10000, percentThresholds: [80, 50, 80], lowBalanceCredits: 500 };

const call = async (method: 'get' | 'put', userId: string, body?: unknown) => {
  const { req, res } = createMocks({ method: method.toUpperCase() as 'GET' | 'PUT', query: { id: 'org1' }, body });
  (req as unknown as { user: unknown }).user = { id: userId, isAdmin: false };
  try {
    await mocks.handlers[method](req, res);
    return { status: res._getStatusCode(), json: res._getJSONData() };
  } catch (error) {
    const { statusCode, status } = error as { statusCode?: number; status?: number };
    return { status: statusCode ?? status, json: null };
  }
};

describe('/api/organizations/[id]/alert-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue(org);
  });

  it('requires the admin:* API-key scope', () => {
    expect(mocks.baseApiOptions).toEqual({ requiredScopes: ['admin:*'] });
  });

  it.each(['owner1', 'manager1'])('lets %s save, deduped and sorted, and clears the evaluator cache', async userId => {
    const { status, json } = await call('put', userId, valid);

    expect(status).toBe(200);
    const saved = { ...valid, percentThresholds: [50, 80] };
    expect(mocks.update).toHaveBeenCalledWith({ id: 'org1', budgetAlerts: saved });
    expect(mocks.clearOrgBudgetAlertCache).toHaveBeenCalledWith('org1');
    expect(json).toEqual({ budgetAlerts: saved });
    expect(mocks.recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'org.budget_alerts.updated' })
    );
  });

  it.each(['get', 'put'] as const)('answers %s from a plain member with 404', async method => {
    const { status } = await call(method, 'member1', valid);

    expect(status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('allows an empty threshold list', async () => {
    expect((await call('put', 'owner1', { ...valid, percentThresholds: [] })).status).toBe(200);
  });

  it.each([
    ['a threshold above 100', { ...valid, percentThresholds: [120] }],
    ['a zero threshold', { ...valid, percentThresholds: [0] }],
    ['a non-array threshold', { ...valid, percentThresholds: 80 }],
    ['more than five thresholds', { ...valid, percentThresholds: [10, 20, 30, 40, 50, 60] }],
    ['an unknown field', { ...valid, extra: true }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await call('put', 'owner1', body)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('returns the stored settings on GET', async () => {
    mocks.findById.mockResolvedValue({ ...org, budgetAlerts: valid });

    expect(await call('get', 'manager1')).toEqual({ status: 200, json: { budgetAlerts: valid } });
  });
});
