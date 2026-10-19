// @vitest-environment node
/**
 * Route tests for POST /api/fabfiles/{id}/apply-edit. Two behaviors share the route: storage
 * accounting (the quota gate runs before any write, and the rewrite is charged through one atomic
 * helper) and Office version retention (trimmed objects are deleted only after the filePath claim
 * wins). `baseApi` is stubbed; appendEditedVersion and deleteDroppedVersions run for real against a
 * mocked storage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { readFileSync } from 'node:fs';
import { NotFoundError, StorageLimitError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  file: undefined as Record<string, unknown> | undefined,
  upload: vi.fn(),
  getSignedUrl: vi.fn(),
  deleteObject: vi.fn(),
  assertRewriteFits: vi.fn(),
  commitContentRewrite: vi.fn(),
  applyEditedText: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = { use: () => chain, post: (fn: unknown) => fn };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/utils/objectId', () => ({ isValidObjectId: () => true }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: h.upload, getSignedUrl: h.getSignedUrl, delete: h.deleteObject }),
}));
vi.mock('@server/utils/aiEditVersionRetention', async orig => ({
  ...(await orig<object>()),
  // Cap of 1: the retention cases below drop every version but the newest.
  getAiEditVersionRetention: async () => 1,
}));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  FabFile: { findById: () => ({ where: () => h.file }) },
  withTransaction: (fn: () => unknown) => fn(),
  adminSettingsRepository: {},
  fabFileRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  fabFilesService: { assertRewriteFits: h.assertRewriteFits, commitContentRewrite: h.commitContentRewrite },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  applyEditedText: h.applyEditedText,
}));

const handler = (await import('../apply-edit')).default as unknown as (req: unknown, res: unknown) => Promise<unknown>;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FILE_ID = 'ff1';
const user = { id: 'u1' };
const version = (n: number) => ({
  version: n,
  filePath: `files/u1/doc/v${n}`,
  fileSize: 10,
  mimeType: DOCX,
  createdAt: new Date(0),
});
const makeFile = (mimeType: string, overrides: Record<string, unknown> = {}) => ({
  _id: FILE_ID,
  id: FILE_ID,
  userId: 'u1',
  fileName: 'doc',
  filePath: 'files/u1/doc',
  fileSize: 10,
  mimeType,
  moderationStatus: 'clean',
  versions: [],
  ...overrides,
});

const call = (newContent: string) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: FILE_ID }, body: { newContent } });
  Object.assign(req, { user, ability: { can: () => true } });
  return handler(req, res).then(() => res);
};

const QUOTA = 'File size exceeds storage limit';
const quotaError = () =>
  new StorageLimitError(QUOTA, {
    errorCode: 'storage_limit_exceeded',
    used_bytes: 900,
    limit_bytes: 1000,
    requested_bytes: 200,
    owner: 'user',
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.assertRewriteFits.mockResolvedValue(undefined);
  h.commitContentRewrite.mockResolvedValue(true);
  h.getSignedUrl.mockResolvedValue('https://s3/signed');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(Buffer.from('original')))
  );
});

describe('POST /api/fabfiles/[id]/apply-edit storage accounting', () => {
  describe('text branch', () => {
    beforeEach(() => {
      h.file = makeFile('text/plain');
    });

    it('charges the rewrite through the helper with the new byte size', async () => {
      await call('new content!');

      expect(h.assertRewriteFits).toHaveBeenCalledWith(h.file, 12, expect.anything(), user);
      expect(h.commitContentRewrite).toHaveBeenCalledWith(
        expect.objectContaining({ fabFileId: FILE_ID, newSize: 12 }),
        expect.anything()
      );
      expect(h.commitContentRewrite.mock.calls[0][0].filter).toBeUndefined();
    });

    it('refuses growth past the quota before writing anything, not even the backup', async () => {
      h.assertRewriteFits.mockRejectedValue(quotaError());

      // Rethrown as-is so the client still gets the used/limit numbers.
      await expect(call('new content!')).rejects.toMatchObject({ message: QUOTA, info: { used_bytes: 900 } });

      expect(h.upload).not.toHaveBeenCalled();
      expect(h.commitContentRewrite).not.toHaveBeenCalled();
    });

    it('propagates a missing owner as a 404 rather than rewrapping it as a 400', async () => {
      h.assertRewriteFits.mockRejectedValue(new NotFoundError('File owner not found'));

      await expect(call('new content!')).rejects.toMatchObject({ statusCode: 404 });
      expect(h.upload).not.toHaveBeenCalled();
    });
  });

  describe('Office branch', () => {
    beforeEach(() => {
      h.file = makeFile(DOCX);
      h.applyEditedText.mockResolvedValue(Buffer.alloc(30));
    });

    it('repoints and charges in one helper call, guarded on the edited filePath', async () => {
      await call('edited text');

      expect(h.assertRewriteFits).toHaveBeenCalledWith(h.file, 30, expect.anything(), user);
      const [args] = h.commitContentRewrite.mock.calls[0];
      expect(args).toMatchObject({ fabFileId: FILE_ID, newSize: 30, filter: { filePath: 'files/u1/doc' } });
      expect(args.set.filePath).toEqual(h.upload.mock.calls[0][1]);
    });

    it('refuses growth past the quota before uploading the new version', async () => {
      h.assertRewriteFits.mockRejectedValue(new Error(QUOTA));

      await expect(call('edited text')).rejects.toThrow(QUOTA);
      expect(h.upload).not.toHaveBeenCalled();
    });

    it('reports a lost repoint race (the helper charged nothing)', async () => {
      h.commitContentRewrite.mockResolvedValue(false);

      await expect(call('edited text')).rejects.toThrow('modified by another edit');
    });
  });
});

describe('apply-edit version retention', () => {
  beforeEach(() => {
    // v1 + 2 edits; with the cap at 1 the next edit drops v2 and v3.
    h.file = makeFile(DOCX, { filePath: version(3).filePath, versions: [version(1), version(2), version(3)] });
    h.applyEditedText.mockResolvedValue(Buffer.from('edited'));
  });

  it('deletes the trimmed versions after the claim wins', async () => {
    const res = await call('edited');

    expect(res._getStatusCode()).toBe(200);
    const persisted = h.commitContentRewrite.mock.calls[0][0].set.versions as { version: number }[];
    expect(persisted.map(v => v.version)).toEqual([1, 4]);
    expect(h.deleteObject.mock.calls.map(([key]) => key)).toEqual([version(2).filePath, version(3).filePath]);
  });

  it('deletes nothing when a concurrent edit wins the claim', async () => {
    h.commitContentRewrite.mockResolvedValue(false);

    await expect(call('edited')).rejects.toThrow('File was modified by another edit');
    expect(h.deleteObject).not.toHaveBeenCalled();
  });
});

// edit.ts runs the same claim-then-delete sequence behind an LLM call too heavy to mock here, so
// pin the order in its source: a delete hoisted above the claim check would destroy history on a
// lost claim.
describe('edit.ts version retention wiring', () => {
  const source = readFileSync(new URL('../edit.ts', import.meta.url), 'utf8');
  // From the opener to the first line that closes the statement: a regex that scans on past the call would match a neighbour.
  const statementFrom = (opener: string) => {
    const start = source.indexOf(opener);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n', source.indexOf(');', start)));
  };

  it('deletes trimmed versions only after the lost-claim throw', () => {
    const claimCheck = source.indexOf('if (!claimed)');
    const lostClaimThrow = source.indexOf("throw new BadRequestError('File was modified", claimCheck);
    const deleteCall = source.indexOf('await deleteDroppedVersions(');
    expect(claimCheck).toBeGreaterThan(-1);
    expect(lostClaimThrow).toBeGreaterThan(claimCheck);
    expect(deleteCall).toBeGreaterThan(lostClaimThrow);
  });

  it('passes the admin cap into appendEditedVersion', () => {
    expect(source).toMatch(/const maxEditedVersions = await getAiEditVersionRetention\(\);/);
    expect(statementFrom('appendEditedVersion({')).toMatch(/\n\s+maxEditedVersions,\n/);
  });

  it('deletes exactly the dropped versions appendEditedVersion returned', () => {
    expect(source).toContain('await deleteDroppedVersions(droppedVersions);');
  });
});
