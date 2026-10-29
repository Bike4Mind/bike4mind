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
    getActiveMetaPrompt: vi.fn(),
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
    h.repo.addMetaPromptVersion.mockResolvedValue({
      versions: [{ versionNumber: 1 }, { versionNumber: 2 }],
      currentVersionNumber: 2,
    });
    const res = await call(settingsHandler, 'POST', { metaPrompt: 'private meta prompt', description: 'd' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.repo.addMetaPromptVersion).toHaveBeenCalledWith('private meta prompt', 'admin-1', 'd');
    expect(h.audit).toHaveBeenCalledTimes(1);
    const input = h.audit.mock.calls[0][1];
    expect(input).toMatchObject({ action: 'settings.agent_ops.version_added', target, details: { version: 2 } });
    expect(JSON.stringify(input)).not.toContain('private meta prompt');
  });

  it('POST of the first version activates it without a separate audit entry', async () => {
    h.repo.getSettings.mockResolvedValue({ versions: [] });
    h.repo.addMetaPromptVersion.mockResolvedValue({ versions: [{ versionNumber: 1 }], currentVersionNumber: 1 });
    h.repo.activateMetaPromptVersion.mockResolvedValue({});
    const res = await call(settingsHandler, 'POST', { metaPrompt: 'p', description: 'd' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.repo.activateMetaPromptVersion).toHaveBeenCalledWith(1);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.agent_ops.version_added',
      details: { version: 1 },
    });
  });

  it('POST records the added version when a legacy version has no number', async () => {
    h.repo.getSettings.mockResolvedValue({ versions: [{}] });
    h.repo.addMetaPromptVersion.mockResolvedValue({
      versions: [{ versionNumber: undefined }, { versionNumber: 1 }],
      currentVersionNumber: 1,
    });
    await call(settingsHandler, 'POST', { metaPrompt: 'p', description: 'd' });
    expect(h.audit.mock.calls[0][1]).toMatchObject({ details: { version: 1 } });
  });

  it('PUT does not audit when nothing changed', async () => {
    h.repo.getSettings.mockResolvedValue({ rateLimitSeconds: 60, isEnabled: true, generationLlmModel: 'm1' });
    h.repo.createOrUpdateSettings.mockResolvedValue({});
    const res = await call(settingsHandler, 'PUT', { rateLimitSeconds: 60, isEnabled: true });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('seed records seeded', async () => {
    h.repo.getSettings.mockResolvedValue(null);
    h.repo.createOrUpdateSettings.mockResolvedValue({});
    h.repo.addMetaPromptVersion.mockResolvedValue({});
    h.repo.activateMetaPromptVersion.mockResolvedValue({});
    const res = await call(seed, 'POST');
    expect(res._getStatusCode()).toBe(200);
    expect(h.repo.addMetaPromptVersion).toHaveBeenCalledWith(
      expect.any(String),
      'admin-1',
      'Initial PromptCrafter meta-prompt for agent system prompt generation'
    );
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

  it('repair does not audit when nothing needed fixing', async () => {
    h.repo.getSettings.mockResolvedValue({ id: 's1' });
    h.findById.mockResolvedValue({
      versions: [{ versionNumber: 1, isActive: true }],
      save: vi.fn().mockResolvedValue(undefined),
      toJSON: () => ({}),
    });
    const res = await call(repair, 'POST');
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('activate records version_activated', async () => {
    h.repo.getActiveMetaPrompt.mockResolvedValue({ versionNumber: 2, isActive: true });
    h.repo.activateMetaPromptVersion.mockResolvedValue({});
    const res = await call(activate, 'POST', undefined, { version: '3' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.agent_ops.version_activated',
      target,
      changes: [{ field: 'activeVersion', before: 2, after: 3 }],
      details: { version: 3 },
    });
  });

  it('activate audits a newly added version even though currentVersionNumber already points at it', async () => {
    // Shape addMetaPromptVersion persists: v2 added and newest, v1 still active.
    h.repo.getSettings.mockResolvedValue({
      currentVersionNumber: 2,
      versions: [
        { versionNumber: 1, isActive: true },
        { versionNumber: 2, isActive: false },
      ],
    });
    h.repo.getActiveMetaPrompt.mockResolvedValue({ versionNumber: 1, isActive: true });
    h.repo.activateMetaPromptVersion.mockResolvedValue({});
    const res = await call(activate, 'POST', undefined, { version: '2' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      changes: [{ field: 'activeVersion', before: 1, after: 2 }],
    });
  });

  it('activate records a null before when no version was active', async () => {
    h.repo.getActiveMetaPrompt.mockResolvedValue(null);
    h.repo.activateMetaPromptVersion.mockResolvedValue({});
    const res = await call(activate, 'POST', undefined, { version: '1' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      changes: [{ field: 'activeVersion', before: null, after: 1 }],
    });
  });

  it('activate does not audit when the version is already active', async () => {
    h.repo.getActiveMetaPrompt.mockResolvedValue({ versionNumber: 3, isActive: true });
    h.repo.activateMetaPromptVersion.mockResolvedValue({});
    const res = await call(activate, 'POST', undefined, { version: '3' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('activate does not audit when the version is not found', async () => {
    h.repo.getActiveMetaPrompt.mockResolvedValue({ versionNumber: 2, isActive: true });
    h.repo.activateMetaPromptVersion.mockRejectedValue(new Error('Version 9 not found'));
    await expect(call(activate, 'POST', undefined, { version: '9' })).rejects.toThrow('not found');
    expect(h.audit).not.toHaveBeenCalled();
  });
});
