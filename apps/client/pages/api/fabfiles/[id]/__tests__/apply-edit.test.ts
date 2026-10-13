// @vitest-environment node
/**
 * Route tests for the Office branch of POST /api/fabfiles/{id}/apply-edit: trimmed versions'
 * objects are deleted only after the atomic filePath claim wins. `baseApi` is stubbed;
 * appendEditedVersion and deleteDroppedVersions run for real against a mocked storage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { readFileSync } from 'node:fs';

const { mockFindById, mockFindOneAndUpdate, mockStorage } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
  mockStorage: { getSignedUrl: vi.fn(), upload: vi.fn(), delete: vi.fn() },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const handlers: Mw[] = [];
    const api = {
      use: (mw: Mw) => (handlers.push(mw), api),
      post: (h: Mw) => async (req: unknown, res: unknown) => {
        for (const mw of [...handlers, h]) {
          let advanced = false;
          await mw(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      },
    };
    return api;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/database', () => ({
  FabFile: { findById: mockFindById, findOneAndUpdate: mockFindOneAndUpdate, updateOne: vi.fn() },
  withTransaction: (fn: () => unknown) => fn(),
  adminSettingsRepository: {},
}));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => mockStorage }));
vi.mock('@server/utils/aiEditVersionRetention', async orig => ({
  ...(await orig<object>()),
  getAiEditVersionRetention: async () => 1,
}));
vi.mock('@bike4mind/utils', async orig => ({
  ...(await orig<object>()),
  applyEditedText: async () => Buffer.from('edited'),
}));

const { default: handler } = await import('@pages/api/fabfiles/[id]/apply-edit');

const FILE_ID = '65a000000000000000000001';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const version = (n: number) => ({
  version: n,
  filePath: `files/u1/${FILE_ID}/v${n}`,
  fileSize: 10,
  mimeType: DOCX,
  createdAt: new Date(0),
});

async function call() {
  const { req, res } = createMocks({ method: 'POST', query: { id: FILE_ID }, body: { newContent: 'edited' } });
  Object.assign(req, { user: { id: 'u1' }, ability: { can: () => true } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  // v1 + 2 edits; with the cap at 1 the next edit drops v2 and v3.
  const file = {
    _id: FILE_ID,
    fileName: 'report.docx',
    mimeType: DOCX,
    filePath: version(3).filePath,
    fileSize: 10,
    versions: [version(1), version(2), version(3)],
    moderationStatus: 'clean',
  };
  mockFindById.mockReturnValue({ where: async () => file });
  mockStorage.getSignedUrl.mockResolvedValue('https://signed.example/x');
  vi.stubGlobal('fetch', async () => new Response(Buffer.from('original')));
});

describe('apply-edit version retention', () => {
  it('deletes the trimmed versions after the claim wins', async () => {
    mockFindOneAndUpdate.mockResolvedValue({});

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    const persisted = mockFindOneAndUpdate.mock.calls[0][1].$set.versions as { version: number }[];
    expect(persisted.map(v => v.version)).toEqual([1, 4]);
    expect(mockStorage.delete.mock.calls.map(([key]) => key)).toEqual([version(2).filePath, version(3).filePath]);
  });

  it('deletes nothing when a concurrent edit wins the claim', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);

    await expect(call()).rejects.toThrow('File was modified by another edit');
    expect(mockStorage.delete).not.toHaveBeenCalled();
  });
});

// edit.ts runs the same claim-then-delete sequence behind an LLM call too heavy to mock here, so
// pin the order in its source: a delete hoisted above the claim check would destroy history on a lost claim.
describe('edit.ts claim-then-delete order', () => {
  it('deletes trimmed versions only after the lost-claim throw', () => {
    const source = readFileSync(new URL('../edit.ts', import.meta.url), 'utf8');
    const claimCheck = source.indexOf('if (!claimed)');
    const lostClaimThrow = source.indexOf("throw new BadRequestError('File was modified", claimCheck);
    const deleteCall = source.indexOf('await deleteDroppedVersions(');
    expect(claimCheck).toBeGreaterThan(-1);
    expect(lostClaimThrow).toBeGreaterThan(claimCheck);
    expect(deleteCall).toBeGreaterThan(lostClaimThrow);
  });
});
