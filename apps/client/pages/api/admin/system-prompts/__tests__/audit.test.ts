// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type RouteFn = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  repo: {
    findOne: vi.fn(),
    findByPromptId: vi.fn(),
    create: vi.fn(),
    updatePrompt: vi.fn(),
    toggleEnabled: vi.fn(),
    upsertPrompt: vi.fn(),
    deletePrompt: vi.fn(),
    updateActiveVersion: vi.fn(),
    createNewVersion: vi.fn(),
    saveToVersion: vi.fn(),
    switchVersion: vi.fn(),
    resetToDefault: vi.fn(),
  },
  defaults: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, RouteFn> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        get: () => chain,
        post: (fn: RouteFn) => ((routes.POST = fn), chain),
        put: (fn: RouteFn) => ((routes.PUT = fn), chain),
        delete: (fn: RouteFn) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('@bike4mind/database', () => ({ systemPromptRepository: h.repo }));
vi.mock('@server/utils/systemPrompts/defaults', () => ({ getDefaultSystemPrompts: h.defaults }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import indexHandler from '../index';
import promptHandler from '../[promptId]';
import createVersion from '../[promptId]/create-version';
import saveVersion from '../[promptId]/save-version';
import switchVersion from '../[promptId]/switch-version';
import reset from '../[promptId]/reset';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const call = async (handler: unknown, method: string, body: unknown, promptId = 'p1') => {
  const { req, res } = createMocks({ method: method as 'POST', body: body as Record<string, unknown> });
  (req as Record<string, unknown>).user = { id: 'admin-1', name: 'Admin', email: 'a@x.test', isAdmin: true };
  (req as Record<string, unknown>).query = { promptId };
  await (handler as Handler)(req, res);
  return res;
};

const longContent = 'x'.repeat(60);

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.defaults.mockReturnValue([{ promptId: 'has_default', name: 'Default Prompt' }]);
});

describe('system prompt admin audit', () => {
  it('POST index records created', async () => {
    h.repo.findOne.mockResolvedValue(null);
    h.repo.create.mockResolvedValue({ promptId: 'p1' });
    const res = await call(indexHandler, 'POST', {
      promptId: 'p1',
      name: 'Prompt One',
      description: 'd',
      content: 'secret prompt text',
      category: 'system',
    });
    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'settings.system_prompt.created',
        target: { kind: 'settings', id: 'p1', displayName: 'Prompt One' },
      })
    );
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('secret prompt text');
  });

  it('PUT records updated with changed field names only', async () => {
    const existing = { name: 'Old', description: 'a long description', content: 'old', category: 'system', version: 1 };
    h.repo.findByPromptId
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce({ ...existing, name: 'New', version: 2 });
    h.repo.updatePrompt.mockResolvedValue({ enabled: true });
    const res = await call(promptHandler, 'PUT', { name: 'New', content: longContent });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const input = h.audit.mock.calls[0][1];
    expect(input).toMatchObject({
      action: 'settings.system_prompt.updated',
      target: { kind: 'settings', id: 'p1', displayName: 'New' },
      changes: [{ field: 'name', before: 'Old', after: 'New' }],
      details: { changedFields: ['name', 'content'], fromVersion: 1, toVersion: 2 },
    });
    expect(JSON.stringify(input)).not.toContain(longContent);
  });

  it('PUT on a missing row records created', async () => {
    h.repo.findByPromptId.mockResolvedValue(null);
    h.repo.upsertPrompt.mockResolvedValue({ name: 'P', category: 'system', enabled: true, version: 1 });
    const res = await call(promptHandler, 'PUT', { content: longContent });
    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'settings.system_prompt.created',
        target: expect.objectContaining({ id: 'p1' }),
      })
    );
  });

  it('DELETE records deleted', async () => {
    h.repo.findByPromptId.mockResolvedValue({ name: 'Probe', version: 3 });
    h.repo.deletePrompt.mockResolvedValue({ deleted: true, historyPreserved: true });
    const res = await call(promptHandler, 'DELETE', undefined);
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'settings.system_prompt.deleted',
        target: { kind: 'settings', id: 'p1', displayName: 'Probe' },
        details: { deletedVersion: 3, historyPreserved: true },
      })
    );
  });

  it('DELETE does not audit a lost race', async () => {
    h.repo.findByPromptId.mockResolvedValue({ name: 'Probe', version: 3 });
    h.repo.deletePrompt.mockResolvedValue({ deleted: false });
    const res = await call(promptHandler, 'DELETE', undefined);
    expect(res._getStatusCode()).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('create-version records version_created', async () => {
    h.repo.findByPromptId.mockResolvedValue({ name: 'P', activeVersion: 1 });
    h.repo.createNewVersion.mockResolvedValue({ version: 4, history: [] });
    const res = await call(createVersion, 'POST', { content: 'body text', setAsActive: false });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.system_prompt.version_created',
      target: { kind: 'settings', id: 'p1', displayName: 'P' },
      details: { version: 4, setAsActive: false },
    });
  });

  it('save-version records version_saved', async () => {
    h.repo.findByPromptId.mockResolvedValue({ name: 'P', activeVersion: 1 });
    h.repo.saveToVersion.mockResolvedValue({ ok: true });
    const res = await call(saveVersion, 'POST', { version: 2, content: 'body text', tags: ['a'] });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.system_prompt.version_saved',
      target: { kind: 'settings', id: 'p1' },
      details: { version: 2, changedFields: ['content', 'tags'] },
    });
  });

  it('switch-version records version_switched with the active-version diff', async () => {
    h.repo.findByPromptId.mockResolvedValue({ name: 'P', activeVersion: 2, version: 3 });
    h.repo.switchVersion.mockResolvedValue({ ok: true });
    const res = await call(switchVersion, 'POST', { targetVersion: 1 });
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.system_prompt.version_switched',
      target: { kind: 'settings', id: 'p1' },
      changes: [{ field: 'activeVersion', before: 2, after: 1 }],
    });
  });

  it('reset records reset', async () => {
    h.repo.findByPromptId.mockResolvedValue({ version: 5 });
    h.repo.resetToDefault.mockResolvedValue({ deleted: true, historyPreserved: true });
    const res = await call(reset, 'POST', undefined, 'has_default');
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.system_prompt.reset',
      target: { kind: 'settings', id: 'has_default', displayName: 'Default Prompt' },
      details: { previousVersion: 5 },
    });
  });

  it('does not audit when the reset fails', async () => {
    h.repo.findByPromptId.mockResolvedValue({ version: 5 });
    h.repo.resetToDefault.mockResolvedValue({ deleted: false });
    const res = await call(reset, 'POST', undefined, 'has_default');
    expect(res._getStatusCode()).toBe(500);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
