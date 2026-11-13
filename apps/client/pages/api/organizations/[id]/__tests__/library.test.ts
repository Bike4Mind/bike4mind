import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createMocks } from 'node-mocks-http';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  access: vi.fn(),
  source: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  find: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get: (fn: Handler) => {
        h.handlers.get = fn;
        return chain;
      },
      post: (_csrf: unknown, fn: Handler) => {
        h.handlers.post = fn;
        return chain;
      },
      patch: (_csrf: unknown, fn: Handler) => {
        h.handlers.patch = fn;
        return chain;
      },
      delete: (_csrf: unknown, fn: Handler) => {
        h.handlers.delete = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@server/organizations/libraryAccess', () => ({ assertLibraryAccess: h.access }));
vi.mock('@bike4mind/database', () => ({
  agentRepository: { findById: h.source },
  skillRepository: { findById: h.source },
  briefcasePromptRepository: { findById: h.source },
  imageGenerationTemplateRepository: { findById: h.source },
  OrganizationLibrary: { create: h.create, findOneAndUpdate: h.update, deleteOne: h.remove, find: h.find },
}));
import '../library';

const ID = '0123456789abcdef01234567';
const run = async (method: string, body: unknown = {}) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'org-a' }, body });
  Object.assign(req, { user: { id: 'author' } });
  await h.handlers[method](req as unknown as Request, res as unknown as Response, vi.fn());
  return res;
};

describe('organization library management API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.access.mockResolvedValue({ id: 'org-a' });
    h.create.mockImplementation(async item => ({ ...item, id: ID }));
    h.source.mockResolvedValue({
      userId: 'author',
      name: 'Helper',
      description: 'Help',
      body: 'Do work',
      type: 'writing',
      promptText: 'Write',
      model: 'flux-pro-1.1',
      settings: {},
    });
  });

  it.each(['agent', 'skill', 'prompt', 'template'])(
    'publishes an owned %s as an independent org snapshot',
    async kind => {
      const res = await run('post', { kind, sourceId: ID, organizationId: 'org-b', userId: 'attacker' });
      expect(res._getStatusCode()).toBe(201);
      expect(h.access).toHaveBeenCalledWith({ id: 'author' }, 'org-a', true);
      expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a', kind, pinned: false }));
      const snapshot = h.create.mock.calls[0][0];
      expect(snapshot).not.toHaveProperty('userId');
      expect(snapshot.definition).not.toHaveProperty('userId');
      expect(snapshot).not.toHaveProperty('sourceId');
    }
  );

  it.each(['post', 'patch', 'delete'])('denies member %s mutations before any write', async method => {
    h.access.mockRejectedValue(new Error('Only organization admins'));
    await expect(run(method, { kind: 'skill', sourceId: ID, itemId: ID, pinned: true })).rejects.toThrow(
      'Only organization admins'
    );
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.source).not.toHaveBeenCalled();
  });

  it('refuses publishing a viewable but unowned source', async () => {
    h.source.mockResolvedValue({ userId: 'another-author', name: 'Private' });
    await expect(run('post', { kind: 'agent', sourceId: ID })).rejects.toThrow('Owned source not found');
    expect(h.create).not.toHaveBeenCalled();
  });

  it('scopes pinning and removal to the requested organization', async () => {
    h.update.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    await expect(run('patch', { itemId: ID, pinned: true })).rejects.toThrow('Library item not found');
    expect(h.update).toHaveBeenCalledWith(
      { _id: ID, organizationId: 'org-a' },
      { $set: { pinned: true } },
      { new: true }
    );
    h.remove.mockResolvedValue({ deletedCount: 0 });
    await expect(run('delete', { itemId: ID })).rejects.toThrow('Library item not found');
    expect(h.remove).toHaveBeenCalledWith({ _id: ID, organizationId: 'org-a' });
  });

  it('returns member-visible metadata with pinned items first', async () => {
    const item = { id: ID, organizationId: 'org-a', name: 'Helper', description: 'Help', kind: 'skill', pinned: true };
    const sort = vi.fn().mockResolvedValue([item]);
    const select = vi.fn().mockReturnValue({ sort });
    h.find.mockReturnValue({ select });
    const res = await run('get');
    expect(h.access).toHaveBeenCalledWith({ id: 'author' }, 'org-a');
    expect(h.find).toHaveBeenCalledWith({ organizationId: 'org-a' });
    expect(select).toHaveBeenCalledWith('-definition');
    expect(sort).toHaveBeenCalledWith({ pinned: -1, name: 1 });
    expect(res._getJSONData()).toEqual({ items: [item] });
  });
});
