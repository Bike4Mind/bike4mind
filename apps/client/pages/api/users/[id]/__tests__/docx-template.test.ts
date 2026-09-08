import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockUserFindById, mockUserFindByIdAndUpdate, mockAppFileFindById, mockAppFileFindByIdAndUpdate } = vi.hoisted(
  () => ({
    mockUserFindById: vi.fn(),
    mockUserFindByIdAndUpdate: vi.fn(),
    mockAppFileFindById: vi.fn(),
    mockAppFileFindByIdAndUpdate: vi.fn(),
  })
);

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.DELETE = fns[fns.length - 1]), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@server/services/docxTemplateService', () => ({
  isValidDocxMimeType: () => true,
  MAX_DOCX_TEMPLATE_SIZE: 10 * 1024 * 1024,
}));

const selectResolving = (value: unknown) => ({ select: () => Promise.resolve(value) });

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (...a: unknown[]) => selectResolving(mockUserFindById(...a)),
    findByIdAndUpdate: (...a: unknown[]) => mockUserFindByIdAndUpdate(...a),
  },
  AppFile: {
    findById: (...a: unknown[]) => selectResolving(mockAppFileFindById(...a)),
    findByIdAndUpdate: (...a: unknown[]) => mockAppFileFindByIdAndUpdate(...a),
  },
}));

import handler from '../docx-template';

const OWN = 'u1';
const FILE_ID = 'file-123';

const call = (method: 'GET' | 'DELETE', userId = OWN) => {
  const { req, res } = createMocks({ method, query: { id: userId } });
  (req as Record<string, unknown>).user = { id: OWN, isAdmin: false };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockUserFindById.mockReset();
  mockUserFindByIdAndUpdate.mockReset().mockResolvedValue({ id: OWN });
  mockAppFileFindById.mockReset();
  mockAppFileFindByIdAndUpdate.mockReset().mockResolvedValue({});
});

describe('GET /api/users/:id/docx-template - foreign template id is not leaked', () => {
  it('returns template:null and clears the stale preference when the stored file is not owned', async () => {
    mockUserFindById.mockReturnValue({ preferences: { docxTemplateFileId: FILE_ID } });
    mockAppFileFindById.mockReturnValue({ userId: 'someone-else', name: 'victim.docx', size: 1, mimeType: 'x' });

    const { res, promise } = call('GET');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ template: null });
    // Foreign file's name/size/mimeType never reach the response.
    expect(JSON.stringify(res._getJSONData())).not.toContain('victim.docx');
    // Stale preference is cleared.
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
      OWN,
      expect.objectContaining({ $unset: { 'preferences.docxTemplateFileId': '' } })
    );
  });

  it('returns the file details when the stored file is owned by the caller', async () => {
    mockUserFindById.mockReturnValue({ preferences: { docxTemplateFileId: FILE_ID } });
    mockAppFileFindById.mockReturnValue({ userId: OWN, name: 'mine.docx', size: 42, mimeType: 'x' });

    const { res, promise } = call('GET');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().template).toMatchObject({ fileId: FILE_ID, fileName: 'mine.docx' });
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/users/:id/docx-template - foreign file tag is not stripped', () => {
  it('does not $pull the DocxTemplate tag from a file the caller does not own', async () => {
    mockUserFindById.mockReturnValue({ preferences: { docxTemplateFileId: FILE_ID } });
    mockAppFileFindById.mockReturnValue({ userId: 'someone-else' });

    const { res, promise } = call('DELETE');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockAppFileFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('strips the DocxTemplate tag from the caller-owned file', async () => {
    mockUserFindById.mockReturnValue({ preferences: { docxTemplateFileId: FILE_ID } });
    mockAppFileFindById.mockReturnValue({ userId: OWN });

    const { res, promise } = call('DELETE');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockAppFileFindByIdAndUpdate).toHaveBeenCalledWith(
      FILE_ID,
      expect.objectContaining({ $pull: expect.anything() })
    );
  });
});
