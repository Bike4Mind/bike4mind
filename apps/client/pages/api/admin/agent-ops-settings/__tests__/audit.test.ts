// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type RouteFn = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  repo: {
    getSettings: vi.fn(),
    createOrUpdateSettings: vi.fn(),
    addMetaPromptVersion: vi.fn(),
    activateMetaPromptVersion: vi.fn(),
  },
  findById: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, RouteFn> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        get: () => chain,
        post: (fn: RouteFn) => ((routes.POST = fn), chain),
        put: (fn: RouteFn) => ((routes.PUT = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  agentOpsSettingsRepository: h.repo,
  apiKeyRepository: {},
  adminSettingsRepository: {},
  AgentOpsSettings: { findById: h.findById },
}));
vi.mock('@bike4mind/services', () => ({ apiKeyService: {} }));
vi.mock('@bike4mind/llm-adapters', () => ({ buildApiKeyTable: vi.fn(), getAvailableModels: vi.fn() }));
vi.mock('@bike4mind/utils', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  BadRequestError: class BadRequestError extends Error {},
  InternalServerError: class InternalServerError extends Error {},
  getSettingsByNames: vi.fn(),
}));
vi.mock('@client/app/utils/agentOpsModels', () => ({ agentOpsModelRejection: vi.fn() }));
vi.mock('@client/server/utils/modelCatalogOptions', () => ({ modelCatalogListingOptions: vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import settingsHandler from '../../agent-ops-settings';
import seed from '../seed';
import repair from '../repair';
import activate from '../versions/[version]/activate';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const call = async (handler: unknown, method: string, body?: unknown, query: Record<string, string> = {}) => {
  const { req, res } = createMocks({ method: method as 'POST', body: body as Record<string, unknown> });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  (req as Record<string, unknown>).query = query;
  await (handler as Handler)(req, res);
  return res;
};

const target = { kind: 'settings', id: 'agent_ops', displayName: 'Agent Ops settings' };

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
});

describe('agent ops admin audit', () => {
  it('PUT records updated with the changed fields', async () => {
    h.repo.getSettings.mockResolvedValue({ rateLimitSeconds: 60, isEnabled: true, generationLlmModel: 'm1' });
    h.repo.createOrUpdateSettings.mockResolvedValue({});
    const res = await call(settingsHandler, 'PUT', { rateLimitSeconds: 30, isEnabled: true });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.agent_ops.updated',
      target,
      changes: [{ field: 'rateLimitSeconds', before: 60, after: 30 }],
    });
  });

  it('POST records version_added without the meta-prompt text', async () => {
    h.repo.getSettings.mockResolvedValue({ versions: [] });
    h.repo.addMetaPromptVersion.mockResolvedValue({ versions: [{ versionNumber: 1 }, { versionNumber: 2 }] });
    const res = await call(settingsHandler, 'POST', { metaPrompt: 'private meta prompt', description: 'd' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const input = h.audit.mock.calls[0][1];
    expect(input).toMatchObject({ action: 'settings.agent_ops.version_added', target, details: { version: 2 } });
    expect(JSON.stringify(input)).not.toContain('private meta prompt');
  });

  it('seed records seeded', async () => {
    h.repo.getSettings.mockResolvedValue(null);
    h.repo.createOrUpdateSettings.mockResolvedValue({});
    h.repo.addMetaPromptVersion.mockResolvedValue({});
    h.repo.activateMetaPromptVersion.mockResolvedValue({});
    const res = await call(seed, 'POST');
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit.mock.calls[0][1]).toMatchObject({ action: 'settings.agent_ops.seeded', target });
  });

  it('seed does not audit when settings already exist', async () => {
    h.repo.getSettings.mockResolvedValue({ versions: [{ versionNumber: 1 }] });
    await call(seed, 'POST');
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('repair records repaired with the fixes made', async () => {
    h.repo.getSettings.mockResolvedValue({ id: 's1' });
    h.findById.mockResolvedValue({
      versions: [{ versionNumber: null, isActive: false }],
      save: vi.fn().mockResolvedValue(undefined),
      toJSON: () => ({}),
    });
    const res = await call(repair, 'POST');
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.agent_ops.repaired',
      target,
      details: { repairsMade: ['Fixed version 1 number', 'Activated first version'] },
    });
  });

  it('activate records version_activated', async () => {
    h.repo.activateMetaPromptVersion.mockResolvedValue({});
    const res = await call(activate, 'POST', undefined, { version: '3' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.agent_ops.version_activated',
      target,
      details: { version: 3 },
    });
  });
});
