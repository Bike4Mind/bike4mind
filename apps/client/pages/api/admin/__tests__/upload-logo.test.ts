import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  getSignedUrl: vi.fn(),
  deleteObject: vi.fn(),
  appFileCtor: vi.fn(),
  findOneAndUpdate: vi.fn(),
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
    findOne: () => ({ session: () => Promise.resolve(null) }),
    findOneAndUpdate: h.findOneAndUpdate,
  },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    getSignedUrl = h.getSignedUrl;
    delete = h.deleteObject;
  },
}));
vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'bucket' } } }));
vi.mock('@server/utils/browserUploadUrl', () => ({
  resolveBrowserAppFileUploadUrl: (_id: string, url: string) => url,
}));

import handler from '../upload-logo';

beforeEach(() => {
  vi.clearAllMocks();
  h.getSignedUrl.mockResolvedValue('https://signed');
  h.findOneAndUpdate.mockResolvedValue(undefined);
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
