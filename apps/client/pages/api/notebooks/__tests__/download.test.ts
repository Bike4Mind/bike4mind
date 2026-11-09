import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { storage, findSession, findFabFile, convert } = vi.hoisted(() => ({
  storage: {
    upload: vi.fn(),
    download: vi.fn(),
    getSignedUrl: vi.fn(),
  },
  findSession: vi.fn(),
  findFabFile: vi.fn(),
  convert: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

// infra/__tests__/fabFileBucketLifecycle.test.ts pins this prefix to the real constant and rule.
vi.mock('@bike4mind/services', () => ({
  fabFilesService: { RESERVED_FAB_FILE_KEY_PREFIX: 'exports/' },
  notebookCurationService: {
    FormatConverter: class {
      convert = convert;
    },
  },
}));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: findSession },
  fabFileRepository: { findById: findFabFile },
}));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => storage,
}));

vi.mock('@bike4mind/server-utils/services/gears/stampGear', () => ({
  stampGear: vi.fn(),
}));

import handler from '../download';

const USER_ID = 'user-1';
const SESSION_A = 'a'.repeat(24);
const SESSION_B = 'b'.repeat(24);
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };

const run = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as Record<string, unknown>).user = { id: USER_ID };
  (req as Record<string, unknown>).logger = logger;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

const fabFiles: Record<string, { id: string; fileName: string; mimeType: string; filePath: string; fileSize: number }> =
  {
    'fab-a': {
      id: 'fab-a',
      fileName: 'a.md',
      mimeType: 'text/markdown',
      filePath: 'curated-notebooks/uuid-a',
      fileSize: 5,
    },
    'fab-b': {
      id: 'fab-b',
      fileName: 'b.md',
      mimeType: 'text/markdown',
      filePath: 'curated-notebooks/uuid-b',
      fileSize: 5,
    },
  };

beforeEach(() => {
  vi.clearAllMocks();
  findSession.mockImplementation(async (id: string) => ({
    id,
    userId: USER_ID,
    curatedNotebookFileId: id === SESSION_A ? 'fab-a' : 'fab-b',
  }));
  findFabFile.mockImplementation(async (id: string) => fabFiles[id]);
  storage.download.mockResolvedValue(Buffer.from('# hello'));
  storage.upload.mockResolvedValue(undefined);
  storage.getSignedUrl.mockImplementation(async (key: string) => `https://example.invalid/${key}`);
  convert.mockResolvedValue({ content: '<p>hello</p>', extension: '.html', mimeType: 'text/html' });
});

describe('POST /api/notebooks/download', () => {
  it('writes a converted single download under the expiring exports namespace', async () => {
    const res = await run({ sessionIds: [SESSION_A], format: 'html' });

    expect(res._getStatusCode()).toBe(200);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    const key = storage.upload.mock.calls[0][1] as string;
    expect(key).toBe(`exports/curated-notebooks/${USER_ID}/${SESSION_A}/a.html`);
    expect(storage.getSignedUrl).toHaveBeenCalledWith(key, 'get', expect.objectContaining({ expiresIn: 3600 }));
    expect(res._getJSONData().data.downloadUrl).toBe(`https://example.invalid/${key}`);
  });

  it('writes a multi-file zip under the expiring exports namespace', async () => {
    const res = await run({ sessionIds: [SESSION_A, SESSION_B], format: 'markdown', downloadAsZip: true });

    expect(res._getStatusCode()).toBe(200);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    const key = storage.upload.mock.calls[0][1] as string;
    expect(key.startsWith(`exports/curated-notebooks/${USER_ID}/batches/`)).toBe(true);
    expect(key.endsWith('.zip')).toBe(true);
    expect(res._getJSONData().data).toMatchObject({ downloadUrl: `https://example.invalid/${key}`, fileCount: 2 });
  });

  it('signs the durable curated key without writing a copy when no conversion is needed', async () => {
    const res = await run({ sessionIds: [SESSION_A], format: 'markdown' });

    expect(res._getStatusCode()).toBe(200);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.getSignedUrl).toHaveBeenCalledWith('curated-notebooks/uuid-a', 'get', expect.anything());
  });

  it('rejects an empty session list before touching storage', async () => {
    const res = await run({ sessionIds: [] });

    expect(res._getStatusCode()).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
