import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

// The superseding write and the first-error-wins guard it deliberately bypasses, run as a pair
// against a real server. Every claim below lives inside a query or a `new: false` option, so a
// mocked caller can only assert that the method was called, not that the write did what its
// caller's ordering argument rests on (see accountFileFailure in fabFileChunk.ts).
describe('supersedeFailureError - the unconditional counterpart to markFailedIfNotAlready', () => {
  setupMongoTest();

  const makeFile = (fields: Record<string, unknown> = {}) =>
    FabFile.create({
      userId: 'u-supersede',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      type: KnowledgeType.FILE,
      filePath: 'report.pdf',
      status: 'complete',
      chunkCount: 0,
      ...fields,
    });

  const storedError = async (id: string) => (await FabFile.findById(id).lean())?.error;

  // The half markFailedIfNotAlready cannot do: a permanent verdict has to land on a file that is
  // already carrying someone else's error, because that is the only state it is ever reached from.
  it('writes over an error the first-error-wins guard declines to touch', async () => {
    const file = await makeFile({ error: 'Chunking failed: corrupt PDF' });
    const id = String(file._id);

    expect(await fabFileRepository.markFailedIfNotAlready(id, 'Could not hand off: refused')).toBe(false);
    expect(await storedError(id)).toBe('Chunking failed: corrupt PDF');

    await fabFileRepository.supersedeFailureError(id, 'Could not hand off: refused');

    expect(await storedError(id)).toBe('Could not hand off: refused');
  });

  // `new: false` is the whole contract of the return value: this write is the only thing that
  // destroys the outgoing text, and the caller logs what comes back so it survives somewhere.
  // Flip it to `new: true` and the log echoes the incoming message instead.
  it('hands back the error it destroyed, not the one it wrote', async () => {
    const file = await makeFile({ error: 'Chunking failed: corrupt PDF' });

    const replaced = await fabFileRepository.supersedeFailureError(String(file._id), 'Could not hand off: refused');

    expect(replaced).toBe('Chunking failed: corrupt PDF');
  });

  it('returns null when there was no error to replace', async () => {
    const file = await makeFile();
    expect(await fabFileRepository.supersedeFailureError(String(file._id), 'Could not hand off: refused')).toBeNull();
    expect(await storedError(String(file._id))).toBe('Could not hand off: refused');
  });

  // Shared with markFailedIfNotAlready through failedFileFields, and load-bearing on both: a file
  // left `isVectorizing: true` beside a terminal error reads as in-flight forever to lakeConvergence.
  it('clears the in-flight marker alongside the error', async () => {
    const file = await makeFile({ error: 'Chunking failed: corrupt PDF', isVectorizing: true });

    await fabFileRepository.supersedeFailureError(String(file._id), 'Could not hand off: refused');

    expect((await FabFile.findById(file._id).lean())?.isVectorizing).toBe(false);
  });

  it('returns null for a file that is gone rather than throwing', async () => {
    const file = await makeFile();
    const id = String(file._id);
    await FabFile.deleteOne({ _id: id });

    expect(await fabFileRepository.supersedeFailureError(id, 'Could not hand off: refused')).toBeNull();
  });
});
