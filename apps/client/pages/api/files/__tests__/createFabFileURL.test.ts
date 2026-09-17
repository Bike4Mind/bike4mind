import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  fabFileCreate: vi.fn(),
  createFabFileByUrl: vi.fn(),
  logEvent: vi.fn(),
}));

// Single-method chain: the route only calls `.use(...).post(...)`, and the ability check in
// `.use` is not the subject here, so the middleware itself is dropped rather than run.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ use: () => ({ post: (h: unknown) => h }) }),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn(async () => 'https://s3.test/get') }),
}));

// The spy that stands in for every FabFile write. The service is mocked below, so a call here can
// only come from the route persisting a second time on its own.
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  dataLakeRepository: {},
  FabFile: { create: h.fabFileCreate },
  User: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: { createFabFileByUrl: h.createFabFileByUrl },
}));

import handler from '../createFabFileURL';

const PERSISTED = { id: 'f1', fileSize: 42, mimeType: 'text/plain' };

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};

const run = (res: unknown) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(
    {
      method: 'POST',
      user: { id: 'u1' },
      ability: { can: () => true },
      body: { url: 'https://example.test/page' },
      logger: { error: vi.fn(), warn: vi.fn() },
    } as never,
    res
  );

describe('POST /api/files/createFabFileURL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createFabFileByUrl.mockResolvedValue(PERSISTED);
  });

  it('persists once per URL upload', async () => {
    const { res } = makeRes();
    await run(res);

    expect(h.createFabFileByUrl).toHaveBeenCalledTimes(1);
    // The row the service returns is already saved; re-creating it here would bypass both
    // admission gates (admin MaxFileSize, storage quota) that only the service applies.
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('returns and logs the row the service persisted', async () => {
    const { res, json } = makeRes();
    await run(res);

    expect(json).toHaveBeenCalledWith(PERSISTED);
    expect(h.logEvent.mock.calls[0][0].metadata).toMatchObject({
      fileId: 'f1',
      fileSize: 42,
      mimeType: 'text/plain',
      fileUrl: 'https://example.test/page',
    });
  });
});
