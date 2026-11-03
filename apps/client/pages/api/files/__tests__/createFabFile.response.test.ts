// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  createFabFile: vi.fn(),
  administeredOrgIds: [] as string[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ use: () => ({ post: (...fns: unknown[]) => fns[fns.length - 1] }) }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/browserUploadUrl', () => ({ resolveBrowserUploadUrl: (_id: string, url: string) => url }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn() }),
}));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  adminSettingsRepository: { getSettingsValue: vi.fn() },
  scopedSettingsRepository: { findOverrides: vi.fn().mockResolvedValue([]) },
  dataLakeRepository: { findByDatalakeTag: vi.fn(), find: vi.fn().mockResolvedValue([]) },
  dataLakeBatchRepository: {},
  dataLakeAccessGrantRepository: { listByLake: vi.fn().mockResolvedValue([]) },
  FabFile: {},
  User: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: vi.fn(async (req: { user: { id: string; isAdmin?: boolean } }) => ({
    userId: req.user.id,
    isAdmin: !!req.user.isAdmin,
    userTags: [],
    entitlementKeys: [],
    administeredOrgIds: h.administeredOrgIds,
  })),
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { ...actual, fabFilesService: { ...actual.fabFilesService, createFabFile: h.createFabFile } };
});
vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'test-fab-bucket' } } }));

import handler from '../createFabFile';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

const run = (body: unknown, user: Record<string, unknown>, res: unknown) =>
  (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { method: 'POST', user, ability: {}, body, logger: { error: vi.fn(), warn: vi.fn() } } as never,
    res
  );

const rawFile = (overrides: Record<string, unknown> = {}) => ({
  id: 'f1',
  fileName: 'report.txt',
  mimeType: 'text/plain',
  fileSize: 10,
  _id: 'raw-object-id',
  __v: 4,
  secretNotInSchema: 'leak',
  ...overrides,
});

describe('POST /api/files/createFabFile response boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.administeredOrgIds = [];
  });

  it('strips undeclared keys and keeps declared ones', async () => {
    h.createFabFile.mockResolvedValue(rawFile());
    const { res, json } = makeRes();

    await run(
      { fileName: 'report.txt', mimeType: 'text/plain', fileSize: 10, type: KnowledgeType.FILE },
      { id: 'u1', isAdmin: false },
      res
    );

    const sent = json.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('_id');
    expect(sent).not.toHaveProperty('__v');
    expect(sent).not.toHaveProperty('secretNotInSchema');
    expect(sent).toMatchObject({ id: 'f1', fileName: 'report.txt', mimeType: 'text/plain', fileSize: 10 });
    expect(sent).not.toHaveProperty('mediaUrl');
  });

  it('keeps mediaUrl for an admin modal-media upload while still stripping undeclared keys', async () => {
    h.createFabFile.mockResolvedValue(
      rawFile({ filePath: 'modal/clip.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4' })
    );
    const { res, json } = makeRes();

    await run(
      {
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        fileSize: 10,
        type: KnowledgeType.FILE,
        purpose: 'modal-media',
      },
      { id: 'u1', isAdmin: true },
      res
    );

    const sent = json.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof sent.mediaUrl).toBe('string');
    expect(sent.mediaUrl).toContain('modal/clip.mp4');
    expect(sent).not.toHaveProperty('_id');
    expect(sent).not.toHaveProperty('__v');
    expect(sent).not.toHaveProperty('secretNotInSchema');
    expect(sent).toMatchObject({ id: 'f1', fileName: 'clip.mp4' });
  });
});
