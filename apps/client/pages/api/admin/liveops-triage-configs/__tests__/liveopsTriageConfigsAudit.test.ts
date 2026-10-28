// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { Types } from 'mongoose';

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  createConfig: vi.fn(),
  isNameUnique: vi.fn(),
  findById: vi.fn(),
  updateConfig: vi.fn(),
  deleteConfig: vi.fn(),
  hasActiveRunForConfig: vi.fn(),
  createLog: vi.fn(),
}));

type Route = (req: unknown, res: unknown) => unknown;

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Route> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (fn: Route) => ((routes.GET = fn), chain),
        post: (fn: Route) => ((routes.POST = fn), chain),
        put: (fn: Route) => ((routes.PUT = fn), chain),
        delete: (fn: Route) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  liveopsTriageConfigRepository: {
    createConfig: h.createConfig,
    isNameUnique: h.isNameUnique,
    findById: h.findById,
    updateConfig: h.updateConfig,
    deleteConfig: h.deleteConfig,
  },
  liveopsTriageRunRepository: { hasActiveRunForConfig: h.hasActiveRunForConfig },
  liveopsTriageConfigAuditLogRepository: { createLog: h.createLog },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import createHandler from '../index';
import itemHandler from '../[id]';

const CONFIG_ID = '507f1f77bcf86cd799439011';
const admin = { id: 'admin-1', username: 'admin', isAdmin: true };

const call = async (
  handler: unknown,
  options: { method: 'POST' | 'PUT' | 'DELETE'; body?: unknown; query?: Record<string, string> }
) => {
  const { req, res } = createMocks(options);
  (req as unknown as Record<string, unknown>).user = admin;
  await (handler as Route)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.createLog.mockResolvedValue(undefined);
  h.isNameUnique.mockResolvedValue(true);
});

describe('liveops triage configs admin audit', () => {
  it('POST records ops.triage_config.created after the config is created', async () => {
    h.createConfig.mockResolvedValue({ id: CONFIG_ID, name: 'Nightly', enabled: false, issueTracker: 'github' });

    const { req, res } = await call(createHandler, {
      method: 'POST',
      body: {
        name: 'Nightly',
        slackChannelId: 'C123ABC',
        issueTracker: 'github',
        githubOwner: 'acme',
        githubRepo: 'app',
        modelId: 'some-model',
      },
    });

    expect(res._getStatusCode()).toBe(201);
    expect(h.createLog).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.triage_config.created',
      target: { kind: 'settings', id: CONFIG_ID, displayName: 'Nightly' },
    });
    expect(h.createConfig.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('PUT records ops.triage_config.updated with the changed field names', async () => {
    h.findById.mockResolvedValue({
      id: CONFIG_ID,
      name: 'Nightly',
      enabled: false,
      issueTracker: 'github',
      githubOwner: 'a',
      githubRepo: 'b',
    });
    h.updateConfig.mockResolvedValue({ id: CONFIG_ID, name: 'Nightly', enabled: true });

    const { res } = await call(itemHandler, { method: 'PUT', query: { id: CONFIG_ID }, body: { enabled: true } });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.triage_config.updated',
      target: { kind: 'settings', id: CONFIG_ID, displayName: 'Nightly' },
      details: { operation: 'enable', changedFields: ['enabled'] },
    });
    expect(h.updateConfig.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('DELETE records ops.triage_config.deleted after the config is deleted', async () => {
    h.findById.mockResolvedValue({ id: CONFIG_ID, name: 'Nightly' });
    h.hasActiveRunForConfig.mockResolvedValue(false);
    h.deleteConfig.mockResolvedValue(true);

    const { res } = await call(itemHandler, { method: 'DELETE', query: { id: CONFIG_ID } });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.triage_config.deleted',
      target: { kind: 'settings', id: CONFIG_ID, displayName: 'Nightly' },
    });
    expect(h.deleteConfig.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('DELETE does not audit when active runs block the deletion', async () => {
    h.findById.mockResolvedValue({ id: CONFIG_ID, name: 'Nightly' });
    h.hasActiveRunForConfig.mockResolvedValue(true);

    const { res } = await call(itemHandler, { method: 'DELETE', query: { id: CONFIG_ID } });

    expect(res._getStatusCode()).toBe(409);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('PUT does not audit when the body changes nothing', async () => {
    h.findById.mockResolvedValue({ id: CONFIG_ID, name: 'Nightly', enabled: true });
    h.updateConfig.mockResolvedValue({ id: CONFIG_ID, name: 'Nightly', enabled: true });

    const { res } = await call(itemHandler, {
      method: 'PUT',
      query: { id: CONFIG_ID },
      body: { enabled: true, name: 'Nightly' },
    });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('PUT does not audit when a Slack-bound config is saved unchanged', async () => {
    const slackWorkspaceId = new Types.ObjectId();
    h.findById.mockResolvedValue({ id: CONFIG_ID, name: 'Nightly', enabled: true, slackWorkspaceId });
    h.updateConfig.mockResolvedValue({ id: CONFIG_ID, name: 'Nightly', enabled: true, slackWorkspaceId });

    const { res } = await call(itemHandler, {
      method: 'PUT',
      query: { id: CONFIG_ID },
      body: { enabled: true, name: 'Nightly', slackWorkspaceId: slackWorkspaceId.toString() },
    });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
