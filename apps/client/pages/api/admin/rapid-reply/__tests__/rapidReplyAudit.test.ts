// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  createLog: vi.fn(),
  prompts: {
    createPrompt: vi.fn(),
    findById: vi.fn(),
    updatePrompt: vi.fn(),
    deletePrompt: vi.fn(),
    activateVersion: vi.fn(),
    setActive: vi.fn(),
    findByModelPair: vi.fn(),
  },
  mappings: {
    createMapping: vi.fn(),
    findById: vi.fn(),
    findByMainModel: vi.fn(),
    updateMapping: vi.fn(),
    deleteMapping: vi.fn(),
  },
  settings: vi.fn(),
  sessionCreate: vi.fn(),
}));

type Route = (req: unknown, res: unknown) => unknown;

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Route> = {};
    const chain: Record<string, unknown> & Route = Object.assign(
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
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
vi.mock('@bike4mind/database/ai', () => ({
  rapidReplyAuditLogRepository: { createLog: h.createLog },
  rapidReplyPromptRepository: h.prompts,
  rapidReplyMappingRepository: h.mappings,
}));
vi.mock('@bike4mind/database/infra', () => ({ adminSettingsRepository: { getSettingsValue: h.settings } }));
vi.mock('@bike4mind/database', () => ({ sessionRepository: { create: h.sessionCreate, delete: vi.fn() } }));
vi.mock('@bike4mind/services/llm', () => ({ ChatCompletionProcess: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: {} }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn(), SQSService: vi.fn() }));
vi.mock('@bike4mind/llm-adapters', () => ({ buildApiKeyTable: vi.fn(), getAvailableModels: vi.fn() }));
vi.mock('@server/auth/turnAuth', () => ({ requestTurnAuth: vi.fn() }));
vi.mock('@server/utils/chatCompletionDefaults', () => ({
  getDefaultChatCompletionOptions: vi.fn(),
  getSharedTokenizer: vi.fn(),
}));
vi.mock('@server/rapidReply/rapidMappingHealth', () => ({ findRottedRapidModelIds: vi.fn() }));

import promptsIndex from '../prompts/index';
import promptById from '../prompts/[id]';
import promptActivate from '../prompts/[id]/activate';
import mappingsIndex from '../mappings/index';
import mappingById from '../mappings/[id]';
import mappingsBulk from '../mappings/bulk';
import testRun from '../test';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const call = async (
  handler: unknown,
  method: 'POST' | 'PUT' | 'DELETE',
  options: { body?: Record<string, unknown>; id?: string } = {}
) => {
  const { req, res } = createMocks({ method, body: options.body ?? {}, query: options.id ? { id: options.id } : {} });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true, email: 'a@example.com' };
  await (handler as Handler)(req, res);
  return { req, res };
};

const prompt = { id: 'p1', name: 'Concise', content: 'SECRET PROMPT TEXT', version: 1, isActive: false };
const mapping = {
  id: 'm1',
  mainModelId: 'main-a',
  rapidModelId: 'rapid-a',
  enabled: true,
  systemPrompt: 'SECRET MAPPING PROMPT',
  priority: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
});

describe('rapid reply prompts admin audit', () => {
  it('records created without prompt content', async () => {
    h.prompts.createPrompt.mockResolvedValue({ ...prompt, isActive: true });
    const { req, res } = await call(promptsIndex, 'POST', { body: { name: 'Concise', content: prompt.content } });

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.rapid_reply_prompt.created',
      target: { kind: 'settings', id: 'p1' },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('SECRET');
    expect(h.createLog.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('records updated with changed field names only', async () => {
    h.prompts.findById.mockResolvedValue(prompt);
    h.prompts.updatePrompt.mockResolvedValue({ ...prompt, content: 'NEW SECRET' });
    const { res } = await call(promptById, 'PUT', { id: 'p1', body: { content: 'NEW SECRET' } });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.rapid_reply_prompt.updated',
      target: { kind: 'settings', id: 'p1' },
      details: { changedFields: ['content'], newVersion: false },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('SECRET');
  });

  it('records nothing for a PUT that changes nothing', async () => {
    h.prompts.findById.mockResolvedValue({ ...prompt, parameters: { temperature: 0.2 } });
    h.prompts.updatePrompt.mockResolvedValue(prompt);
    const { res } = await call(promptById, 'PUT', {
      id: 'p1',
      body: { name: 'Concise', content: prompt.content, parameters: { temperature: 0.2 } },
    });

    expect(res._getStatusCode()).toBe(200);
    expect(h.createLog).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('targets the parent when a child version is edited, and records a rename', async () => {
    h.prompts.findById.mockResolvedValue({ ...prompt, id: 'p1-v2', parentId: 'p1', version: 2 });
    h.prompts.updatePrompt.mockResolvedValue({ ...prompt, id: 'p1-v2', name: 'Brief' });
    await call(promptById, 'PUT', { id: 'p1-v2', body: { name: 'Brief' } });

    expect(h.audit.mock.calls[0][1]).toMatchObject({
      target: { kind: 'settings', id: 'p1' },
      details: { promptId: 'p1-v2', changedFields: ['name'], name: { before: 'Concise', after: 'Brief' } },
    });
  });

  it('records deleted', async () => {
    h.prompts.findById.mockResolvedValue(prompt);
    h.prompts.deletePrompt.mockResolvedValue(true);
    const { res } = await call(promptById, 'DELETE', { id: 'p1' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.rapid_reply_prompt.deleted',
      target: { kind: 'settings', id: 'p1' },
    });
    expect(h.prompts.deletePrompt.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('records activated', async () => {
    h.prompts.findById.mockResolvedValue(prompt);
    h.prompts.activateVersion.mockResolvedValue({ ...prompt, isActive: true });
    h.prompts.setActive.mockResolvedValue({ ...prompt, isActive: true });
    const { res } = await call(promptActivate, 'POST', { id: 'p1' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.rapid_reply_prompt.activated',
      target: { kind: 'settings', id: 'p1' },
    });
  });

  it('records activation of a child version against the parent', async () => {
    h.prompts.findById.mockResolvedValue({ ...prompt, id: 'p1-v2', parentId: 'p1', version: 2 });
    h.prompts.activateVersion.mockResolvedValue(true);
    await call(promptActivate, 'POST', { id: 'p1-v2' });

    expect(h.audit.mock.calls[0][1]).toMatchObject({
      target: { kind: 'settings', id: 'p1' },
      details: { promptId: 'p1-v2', version: 2 },
    });
  });
});

describe('rapid reply mappings admin audit', () => {
  it('records created', async () => {
    h.mappings.findByMainModel.mockResolvedValue(null);
    h.mappings.createMapping.mockResolvedValue(mapping);
    const { res } = await call(mappingsIndex, 'POST', {
      body: { mainModelId: 'main-a', rapidModelId: 'rapid-a', systemPrompt: 'x' },
    });

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.rapid_reply_mapping.created',
      target: { kind: 'settings', id: 'm1' },
    });
  });

  it('records updated and omits systemPrompt values', async () => {
    h.mappings.findById.mockResolvedValue(mapping);
    h.mappings.updateMapping.mockResolvedValue({ ...mapping, enabled: false });
    const { res } = await call(mappingById, 'PUT', {
      id: 'm1',
      body: { enabled: false, systemPrompt: 'NEW SECRET' },
    });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.rapid_reply_mapping.updated',
      target: { kind: 'settings', id: 'm1' },
      changes: [
        { field: 'enabled', before: true, after: false },
        { field: 'systemPrompt', before: '[omitted]', after: '[omitted]' },
      ],
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('SECRET');
  });

  it('records nothing for a PUT that changes nothing', async () => {
    h.mappings.findById.mockResolvedValue(mapping);
    h.mappings.updateMapping.mockResolvedValue(mapping);
    const { res } = await call(mappingById, 'PUT', { id: 'm1', body: { enabled: true, priority: 1 } });

    expect(res._getStatusCode()).toBe(200);
    expect(h.createLog).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('records deleted', async () => {
    h.mappings.findById.mockResolvedValue(mapping);
    h.mappings.deleteMapping.mockResolvedValue(true);
    const { res } = await call(mappingById, 'DELETE', { id: 'm1' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.rapid_reply_mapping.deleted',
      target: { kind: 'settings', id: 'm1' },
    });
  });

  it('records bulk_updated with per-operation outcomes', async () => {
    h.mappings.findById.mockResolvedValue(mapping);
    h.mappings.updateMapping.mockResolvedValue({ ...mapping, enabled: false });
    const { res } = await call(mappingsBulk, 'POST', {
      body: {
        operations: [
          { id: 'm1', action: 'disable' },
          { id: 'm2', action: 'bogus' },
        ],
      },
    });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.rapid_reply_mapping.bulk_updated',
      target: { kind: 'settings' },
      details: {
        total: 2,
        successful: 1,
        failed: 1,
        operations: [
          { id: 'm1', action: 'disable', success: true },
          { id: 'm2', action: 'bogus', success: false },
        ],
      },
    });
  });

  it('records changed field names for bulk updates', async () => {
    h.mappings.findById.mockResolvedValue(mapping);
    h.mappings.updateMapping.mockResolvedValue(mapping);
    await call(mappingsBulk, 'POST', {
      body: { operations: [{ id: 'm1', action: 'update', data: { priority: 5, systemPrompt: 'NEW SECRET' } }] },
    });

    expect(h.audit.mock.calls[0][1].details.operations).toEqual([
      { id: 'm1', action: 'update', success: true, changedFields: ['priority', 'systemPrompt'] },
    ]);
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('SECRET');
  });

  it('caps the audited bulk operations and coerces echoed ids to bounded strings', async () => {
    const operations = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, action: 'bogus' }));
    operations[0] = { id: { $gt: '' } as unknown as string, action: 'bogus' };
    operations[1] = { id: 'x'.repeat(1000), action: 'bogus' };
    await call(mappingsBulk, 'POST', { body: { operations } });

    const details = h.audit.mock.calls[0][1].details;
    expect(details.total).toBe(150);
    expect(details.truncated).toBe(true);
    expect(details.operations).toHaveLength(100);
    expect(details.operations[0].id).toBe('[object Object]');
    expect(details.operations[1].id).toHaveLength(200);
  });
});

describe('rapid reply test run admin audit', () => {
  it('records test_run even when the run itself failed', async () => {
    h.settings.mockResolvedValue({ enabled: true });
    h.mappings.findByMainModel.mockResolvedValue({
      ...mapping,
      maxLatency: 2000,
      maxTokens: 150,
      responseStyle: 'concise',
      usageCount: 1,
    });
    h.prompts.findByModelPair.mockResolvedValue([]);
    h.sessionCreate.mockRejectedValue(new Error('boom'));

    const { req, res } = await call(testRun, 'POST', { body: { mainModelId: 'main-a' } });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.rapid_reply.test_run',
      target: { kind: 'settings', id: 'main-a' },
      details: { mainModelId: 'main-a', success: false },
    });
    expect(h.createLog.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});
