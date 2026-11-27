import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  getSignedUrl: vi.fn(),
  deleteObject: vi.fn(),
  appFileCtor: vi.fn(),
  findOneAndUpdate: vi.fn(),
  stored: null as unknown,
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => unknown> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) await middleware(req, res, () => undefined);
        return routes[(req as { method?: string }).method ?? 'POST']?.(req, res);
      },
      {
        use: (fn: (typeof middlewares)[number]) => (middlewares.push(fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((routes.POST = fn), chain),
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));

// Mirrors withTransaction: work queued with runAfterCommit runs only once the callback resolves.
vi.mock('@bike4mind/database', () => ({
  withTransaction: async (fn: (session: unknown) => unknown) => {
    const queue = new Map<string, () => Promise<unknown>>();
    const result = await fn({ queue });
    for (const work of queue.values()) await work();
    return result;
  },
  runAfterCommit: (
    session: { queue: Map<string, () => Promise<unknown>> },
    key: string,
    work: () => Promise<unknown>
  ) => {
    session.queue.set(key, work);
    return true;
  },
}));
vi.mock('@bike4mind/database/content', () => ({
  AppFile: class {
    id = 'new-file-id';
    constructor(doc: Record<string, unknown>) {
      h.appFileCtor(doc);
    }
    save = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: {
    findOne: () => ({ session: () => Promise.resolve(h.stored) }),
    findOneAndUpdate: h.findOneAndUpdate,
  },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    getSignedUrl = h.getSignedUrl;
    delete = h.deleteObject;
  },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'bucket' } } }));
vi.mock('@server/utils/browserUploadUrl', () => ({
  resolveBrowserAppFileUploadUrl: (_id: string, url: string) => url,
}));

import handler from '../upload-logo';

beforeEach(() => {
  vi.clearAllMocks();
  h.getSignedUrl.mockResolvedValue('https://signed');
  h.findOneAndUpdate.mockResolvedValue(undefined);
  h.stored = null;
  h.audit.mockResolvedValue(null);
});

describe('POST /api/admin/upload-logo', () => {
  it('binds the declared fileSize into the presigned PUT, so S3 refuses a logo of any other length', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      body: { fileName: 'logo.png', mimeType: 'image/png', fileSize: 321 },
    });
    (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(h.getSignedUrl).toHaveBeenCalledWith(expect.stringMatching(/^admin\/logos\//), 'put', {
      expiresIn: 600,
      ContentLength: 321,
    });
    expect(h.appFileCtor).toHaveBeenCalledWith(expect.objectContaining({ size: 321 }));
  });
});

const run = async (method: 'POST' | 'DELETE', body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method, body });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  (req as Record<string, unknown>).logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const outcome = await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res).then(
    () => undefined,
    (error: Error) => error
  );
  return { req, res, error: outcome };
};

describe('upload-logo admin audit', () => {
  it('POST records a strict logoSettings entry with the before and after URL', async () => {
    const { req } = await run('POST', { fileName: 'logo.png', mimeType: 'image/png', fileSize: 321 });

    expect(h.audit).toHaveBeenCalledTimes(1);
    const [auditReq, entry] = h.audit.mock.calls[0];
    expect(auditReq).toBe(req);
    expect(entry).toMatchObject({
      action: 'settings.admin_settings.updated',
      target: { kind: 'settings', id: 'logoSettings' },
      summary: 'uploaded a custom light logo',
      changes: [expect.objectContaining({ field: 'logoSettings.customLogoUrl', before: '' })],
    });
    expect(entry.changes[0].after).toEqual(expect.stringMatching(/^custom-light-logo-/));
    expect(h.findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('POST does not report success when the audit write rejects', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));

    const { res, error } = await run('POST', { fileName: 'logo.png', mimeType: 'image/png', fileSize: 321 });

    expect(error?.message).toBe('audit down');
    expect(res._isEndCalled()).toBe(false);
  });

  it('DELETE records the removed logo as a change to the stored URL', async () => {
    h.stored = { settingValue: { customLogoUrl: 'old.png', customDarkLogoUrl: '', useBothLogos: false } };

    await run('DELETE', { isDarkMode: false });

    expect(h.deleteObject).toHaveBeenCalledWith('admin/logos/old.png');
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.admin_settings.updated',
      target: { kind: 'settings', id: 'logoSettings' },
      summary: 'removed the custom light logo',
      changes: [{ field: 'logoSettings.customLogoUrl', before: 'old.png', after: '' }],
    });
  });

  it('DELETE keeps the old object when the audit write rejects', async () => {
    h.stored = { settingValue: { customLogoUrl: 'old.png', customDarkLogoUrl: '', useBothLogos: false } };
    h.audit.mockRejectedValue(new Error('audit down'));

    await run('DELETE', { isDarkMode: false });

    expect(h.deleteObject).not.toHaveBeenCalled();
  });

  it('POST deletes the replaced logo object once the transaction commits', async () => {
    h.stored = { settingValue: { customLogoUrl: 'old.png', customDarkLogoUrl: '', useBothLogos: false } };

    const { error } = await run('POST', { fileName: 'logo.png', mimeType: 'image/png', fileSize: 321 });

    expect(error).toBeUndefined();
    expect(h.deleteObject).toHaveBeenCalledWith('admin/logos/old.png');
  });

  it('POST keeps the old object when the audit write rejects', async () => {
    h.stored = { settingValue: { customLogoUrl: 'old.png', customDarkLogoUrl: '', useBothLogos: false } };
    h.audit.mockRejectedValue(new Error('audit down'));

    await run('POST', { fileName: 'logo.png', mimeType: 'image/png', fileSize: 321 });

    expect(h.deleteObject).not.toHaveBeenCalled();
  });

  it('DELETE still succeeds when the post-commit object delete fails', async () => {
    h.stored = { settingValue: { customLogoUrl: 'old.png', customDarkLogoUrl: '', useBothLogos: false } };
    h.deleteObject.mockRejectedValue(new Error('s3 down'));

    const { res, error } = await run('DELETE', { isDarkMode: false });

    expect(error).toBeUndefined();
    expect(res._getStatusCode()).toBe(200);
  });

  it('DELETE does not report success when the audit write rejects', async () => {
    h.stored = { settingValue: { customLogoUrl: 'old.png', customDarkLogoUrl: '', useBothLogos: false } };
    h.audit.mockRejectedValue(new Error('audit down'));

    const { res, error } = await run('DELETE', { isDarkMode: false });

    expect(error?.message).toBe('audit down');
    expect(res._isEndCalled()).toBe(false);
  });
});

describe('/api/admin/upload-logo permission gate', () => {
  it.each(['POST', 'DELETE'] as const)('refuses %s for a user without admin access before any work', async method => {
    const { req, res } = createMocks({
      method,
      body: { fileName: 'logo.png', mimeType: 'image/png', fileSize: 321 },
    });
    (req as Record<string, unknown>).user = { id: 'user-1', isAdmin: false };

    await expect((handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res)).rejects.toThrow(
      /missing permission/i
    );
    expect(h.getSignedUrl).not.toHaveBeenCalled();
    expect(h.deleteObject).not.toHaveBeenCalled();
    expect(h.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
