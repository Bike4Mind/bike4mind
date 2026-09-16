import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  upload: vi.fn(),
  getMetadata: vi.fn(),
  warn: vi.fn(),
}));

// fabFileManager pulls the whole DB/storage/pipeline graph at module load; stub it down to the two
// collaborators this path actually drives.
vi.mock('@bike4mind/database', () => ({ mongoose: {}, FabFile: { findOneAndUpdate: h.findOneAndUpdate } }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: h.upload, getMetadata: h.getMetadata }),
}));
vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));
vi.mock('@server/auth/ability', () => ({ Ability: class {} }));
vi.mock('@bike4mind/observability', () => ({ Logger: { warn: h.warn } }));
vi.mock('@bike4mind/fab-pipeline', () => ({ EmbeddingService: class {} }));

import { updateFabFile } from './fabFileManager';

const filePath = 'files/contract.pdf';
const session = {} as never;
const ability = {} as never;

// The shape findOneAndUpdate hands back: a hydrated doc, so `save()` runs schema validators where the
// findOneAndUpdate above it does not.
const hydratedFile = () => ({ filePath, mimeType: 'application/pdf', fileSize: 1, save: vi.fn() });

const updateWithSameFilePath = (doc: ReturnType<typeof hydratedFile>) => {
  h.findOneAndUpdate.mockReturnValue({ exec: async () => doc });
  return updateFabFile('f1', { filePath }, 'body', ability, session);
};

describe('updateFabFile - recording the size S3 reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getMetadata.mockResolvedValue({ size: 4096 });
  });

  // The save intends `fileSize` alone, and validating the untouched paths is what let an enum widened
  // by a newer deploy (CHUNK_STALL_REASONS gaining a member) fail this write on an instance still
  // running the old schema - swallowed by the catch below, so the size was silently never recorded.
  it('validates only the modified path, so a value a newer schema added cannot fail the write', async () => {
    const doc = hydratedFile();
    await updateWithSameFilePath(doc);

    expect(doc.fileSize).toBe(4096);
    expect(doc.save).toHaveBeenCalledWith({ session, validateModifiedOnly: true });
  });

  // Why this is a lost update and not an error the caller sees: the main record already persisted via
  // findOneAndUpdate, so the request succeeds either way. Anything failing here must therefore be
  // legible in the log, which is the other half of the fix.
  it('swallows a failure and still returns the record the update already persisted', async () => {
    const doc = hydratedFile();
    const validationError = new Error('chunkStallReason: `unchunkedPaused` is not a valid enum value');
    doc.save.mockRejectedValue(validationError);

    await expect(updateWithSameFilePath(doc)).resolves.toBe(doc);
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('file size'), validationError);
  });

  it('records nothing when S3 reports no size', async () => {
    const doc = hydratedFile();
    h.getMetadata.mockResolvedValue({});

    await updateWithSameFilePath(doc);

    expect(doc.save).not.toHaveBeenCalled();
    expect(doc.fileSize).toBe(1);
  });
});
