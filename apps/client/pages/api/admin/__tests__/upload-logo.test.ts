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
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'POST']?.(req, res),
      {
        post: (fn: (req: unknown, res: unknown) => unknown) => ((routes.POST = fn), chain),
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({ withTransaction: (fn: (session: unknown) => unknown) => fn({}) }));
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
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
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

  it('DELETE does not report success when the audit write rejects', async () => {
    h.stored = { settingValue: { customLogoUrl: 'old.png', customDarkLogoUrl: '', useBothLogos: false } };
    h.audit.mockRejectedValue(new Error('audit down'));

    const { res, error } = await run('DELETE', { isDarkMode: false });

    expect(error?.message).toBe('audit down');
    expect(res._isEndCalled()).toBe(false);
  });
});
