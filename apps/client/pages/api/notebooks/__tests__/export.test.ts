import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockExport } = vi.hoisted(() => ({ mockExport: vi.fn() }));

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

// Only the service class is doubled. NotebookExportError is the REAL one, so the status this route
// answers is the status the error actually carries - a replica would let the two drift apart and
// keep asserting the old behaviour with nothing failing. Imported from source because that module
// is pure (one `import type`), while pulling the whole services barrel in costs seconds of module
// load for one Error class. The route's `instanceof` resolves to this same object, since its
// binding comes from this mock.
vi.mock('@bike4mind/services', async () => ({
  notebookExportService: {
    ...(await import('../../../../../../b4m-core/services/src/notebookExportService/types')),
    NotebookExportService: class {
      exportNotebooks = mockExport;
    },
  },
}));

const { NotebookExportError } = await import('../../../../../../b4m-core/services/src/notebookExportService/types');

vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    withMetadata() {
      return this;
    }
  },
}));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: {},
  questRepository: {},
  fabFileRepository: {},
  artifactRepository: {},
  agentRepository: {},
  Tool: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({}) }));

import handler from '../export';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };

const run = (body: Record<string, unknown> = {}, user: unknown = { id: 'user-1' }) => {
  const { req, res } = createMocks({ method: 'POST', body });
  if (user) (req as Record<string, unknown>).user = user;
  (req as Record<string, unknown>).logger = logger;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const HEX_ID = '67dbe18a7f9cf1fa5d9686aa';

beforeEach(() => {
  mockExport.mockReset().mockResolvedValue({
    downloadUrl: 'https://example.invalid/export.zip',
    fileSize: 1024,
    notebookCount: 1,
    messageCount: 2,
    attachmentCount: 0,
  });
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe('POST /api/notebooks/export', () => {
  it('rejects a malformed notebookId at the schema, before the service is reached', async () => {
    const { res, promise } = run({ notebookIds: ['optimistic-session-abc'] });
    await promise;

    expect(res._getStatusCode()).toBe(400);
    expect(mockExport).not.toHaveBeenCalled();
    expect(res._getJSONData().errors).toContainEqual(
      expect.objectContaining({ field: 'notebookIds.0', message: 'must be a 24-character hex notebook id' })
    );
    // The service is never reached here, so this is the only line that records the fault at all.
    expect(logger.warn).toHaveBeenCalledWith(
      'Notebook export rejected at the schema',
      expect.objectContaining({ userId: 'user-1', fields: ['notebookIds.0'] })
    );
  });

  it('answers 400 with the service code when the export is rejected as a caller fault', async () => {
    mockExport.mockRejectedValue(new NotebookExportError('bad ids: nope', 'INVALID_NOTEBOOK_ID'));
    const { res, promise } = run({ notebookIds: [HEX_ID] });
    await promise;

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ success: false, code: 'INVALID_NOTEBOOK_ID', message: 'bad ids: nope' });
  });

  it('answers 404 when the account has no notebooks to export', async () => {
    mockExport.mockRejectedValue(new NotebookExportError('No notebooks found', 'NO_NOTEBOOKS'));
    const { res, promise } = run();
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toMatchObject({ code: 'NO_NOTEBOOKS' });
  });

  it('does not log a caller rejection again - the service already wrote that line', async () => {
    mockExport.mockRejectedValue(new NotebookExportError('No notebooks found', 'NO_NOTEBOOKS'));
    const { promise } = run();
    await promise;

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps a genuine fault at 500 and loud, so a real outage still pages', async () => {
    mockExport.mockRejectedValue(new NotebookExportError('upload died', 'EXPORT_FAILED'));
    const { res, promise } = run();
    await promise;

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData().message).toBe('Export failed. Please try again later.');
    expect(logger.error).toHaveBeenCalledWith('Notebook export failed', expect.objectContaining({ userId: 'user-1' }));
  });

  it('keeps a non-NotebookExportError at 500 and loud', async () => {
    mockExport.mockRejectedValue(new Error('mongo is on fire'));
    const { res, promise } = run();
    await promise;

    expect(res._getStatusCode()).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns the export payload on success', async () => {
    const { res, promise } = run({ notebookIds: [HEX_ID] });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().data).toMatchObject({
      downloadUrl: 'https://example.invalid/export.zip',
      notebookCount: 1,
    });
    expect(mockExport).toHaveBeenCalledWith('user-1', expect.objectContaining({ notebookIds: [HEX_ID] }));
  });

  it('rejects an unauthenticated caller', async () => {
    const { res, promise } = run({}, null);
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(mockExport).not.toHaveBeenCalled();
  });
});
