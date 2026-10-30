// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  createFabFileByUrl: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ use: () => ({ post: (...fns: unknown[]) => fns[fns.length - 1] }) }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn() }),
}));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  dataLakeRepository: {},
  FabFile: {},
  User: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { ...actual, fabFilesService: { ...actual.fabFilesService, createFabFileByUrl: h.createFabFileByUrl } };
});

import handler from '../createFabFileURL';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

const run = (res: unknown) =>
  (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    {
      method: 'POST',
      user: { id: 'u1' },
      ability: { can: () => true },
      body: { url: 'https://example.test/page' },
      logger: { error: vi.fn(), warn: vi.fn() },
    } as never,
    res
  );

describe('POST /api/files/createFabFileURL response boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips keys the response schema does not declare and keeps declared ones', async () => {
    h.createFabFileByUrl.mockResolvedValue({
      id: 'f1',
      fileName: 'page.html',
      fileSize: 42,
      mimeType: 'text/html',
      _id: 'raw-object-id',
      __v: 3,
      secretNotInSchema: 'leak',
    });
    const { res, json } = makeRes();

    await run(res);

    const sent = json.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('_id');
    expect(sent).not.toHaveProperty('__v');
    expect(sent).not.toHaveProperty('secretNotInSchema');
    expect(sent).toMatchObject({ id: 'f1', fileName: 'page.html', fileSize: 42, mimeType: 'text/html' });
  });
});
