import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IFabFileDocument, ModelInfo } from '@bike4mind/common';

const mockGetFileContent = vi.fn();
vi.mock('../fabfile', () => ({ getFileContent: (...a: unknown[]) => mockGetFileContent(...a) }));

import { processFabFilesServer } from './utils';

/**
 * The attachment cosine path reads chunks through a bounded keyset walk. What is under test here is
 * not the ranking - `utils.test.ts` covers that - but the three things the bound introduces: it has
 * to stop, it has to say when it stopped, and it must never leave the attachment contributing
 * nothing. Mirrors the constants in utils.ts: COSINE_SEARCH_MAX_CHUNKS_SCANNED = 2000, page 200.
 */
const MAX_SCANNED = 2000;
const PAGE_SIZE = 200;

const logger = {
  info: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  updateMetadata: vi.fn(),
};

/** Did anything warn about the scan bound specifically (as opposed to the excerpt notice)? */
const warnedAboutTheBound = () => logger.warn.mock.calls.some(c => String(c[0]).includes(`${MAX_SCANNED}-chunk bound`));

const modelInfo = { id: 'm', supportsVision: false, backend: 'openai' } as unknown as ModelInfo;

// Query vector is [1, 0]; a chunk's vector width decides whether it is comparable at all.
const embeddingFactory = {
  getDefaultEmbeddingModel: () => 'text-embedding-ada-002',
  createEmbeddingService: () => ({
    getModelInfo: () => ({ model: 'text-embedding-ada-002', contextWindow: 8192 }),
    generateEmbedding: async () => [1, 0],
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal factory shape for this unit test
} as any;

const vectorizedFile = (): IFabFileDocument =>
  ({
    id: 'file-1',
    fileName: 'roster.csv',
    mimeType: 'text/csv',
    vectorized: true,
    embeddingModel: 'text-embedding-ada-002',
  }) as IFabFileDocument;

type Row = { id: string; text: string; vector: number[] };

/** Zero-padded so lexicographic order matches insertion order, as a real ObjectId string does. */
const rows = (count: number, vector: (i: number) => number[] = () => [1, 0.5], text = 'body'): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `chunk-${String(i).padStart(6, '0')}`,
    text: `${text}-${i}`,
    vector: vector(i),
  }));

/**
 * Real keyset arithmetic. A page-keyed mock would return a canned page per call and so could not
 * observe a wrong cursor - the one defect paging actually introduces.
 */
const pagedRepo = (all: Row[], totalChunksOverride?: number) => ({
  findVectorsByFabFileIds: vi.fn(async (_ids: string[], opts?: { limit?: number; afterChunkId?: string }) =>
    all
      .filter(r => r.vector.length > 0)
      .filter(r => (opts?.afterChunkId ? r.id > opts.afterChunkId : true))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, opts?.limit ?? all.length)
      .map(r => ({ id: r.id, fabFileId: 'file-1', text: r.text, vector: r.vector }))
  ),
  countByFabFileId: vi.fn(async () => totalChunksOverride ?? all.length),
});

const run = async (
  chunkRepo: ReturnType<typeof pagedRepo> | Record<string, unknown>,
  { maxTokens = 4_000_000, fileUpdate = vi.fn() } = {}
) => {
  const result = await processFabFilesServer(
    embeddingFactory,
    [vectorizedFile()],
    'who is on the roster',
    maxTokens,
    modelInfo,
    async () => {},
    {
      logger: logger as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage only matters on the raw-content arm
      storage: { download: vi.fn() } as any,
      db: {
        fabfilechunks: chunkRepo,
        fabfiles: { update: fileUpdate },
        caches: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape
      } as any,
    }
  );
  return {
    ...result,
    text: result.userMessages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n'),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetFileContent.mockResolvedValue('RAW-FILE-BODY');
});

describe('the attachment cosine scan is bounded', () => {
  it('stops reading at the chunk bound instead of walking the whole file', async () => {
    // 3000 chunks against a 2000-chunk bound. Without the bound the walk drains the file.
    const repo = pagedRepo(rows(3000));

    await run(repo);

    const consumed = repo.findVectorsByFabFileIds.mock.calls.length;
    // ceil(2000/200) pages of work, plus at most one more that finds the budget spent.
    expect(consumed).toBeLessThanOrEqual(Math.ceil(MAX_SCANNED / PAGE_SIZE) + 1);
    // And it never asked for a row past the bound: a page's limit is at most page-size plus the probe.
    for (const call of repo.findVectorsByFabFileIds.mock.calls) {
      expect(call[1]?.limit).toBeLessThanOrEqual(PAGE_SIZE + 1);
    }
  });

  it('advances the cursor rather than re-reading the first page', async () => {
    const repo = pagedRepo(rows(500));

    await run(repo);

    const cursors = repo.findVectorsByFabFileIds.mock.calls.map(c => c[1]?.afterChunkId);
    expect(cursors[0]).toBeUndefined();
    expect(cursors.slice(1).every(c => typeof c === 'string')).toBe(true);
    expect(new Set(cursors).size).toBe(cursors.length);
  });

  it('throws rather than paging forever when the cursor does not advance', async () => {
    // A repository that ignores afterChunkId would otherwise spin until the page cap.
    const stuck = {
      findVectorsByFabFileIds: vi.fn(async () =>
        rows(PAGE_SIZE + 1).map(r => ({ id: r.id, fabFileId: 'file-1', text: r.text, vector: r.vector }))
      ),
      countByFabFileId: vi.fn(async () => 5000),
    };

    await expect(run(stuck)).rejects.toThrow(/cursor failed to advance/);
  });

  it('tells the model it is holding a subset when the bound cut the scan', async () => {
    const { text } = await run(pagedRepo(rows(3000)));

    expect(text).toContain('Data for roster.csv:');
    // The excerpt notice is the model-facing half of the bound; without it a truncated scan reads
    // as the whole file.
    expect(text.toLowerCase()).toContain('excerpt');
    expect(warnedAboutTheBound()).toBe(true);
  });

  it('does not report a truncation when the file exactly fills the bound', async () => {
    // Exactly at the bound nothing was dropped, and this is what the probe row exists to tell apart
    // from an overflow. A warning that fires on healthy data is one nobody reads.
    await run(pagedRepo(rows(MAX_SCANNED)));

    expect(warnedAboutTheBound()).toBe(false);
  });

  it('stays silent on a small file it delivered whole', async () => {
    // The healthy path: three chunks, all three inside the top-K, nothing withheld. No notice at all.
    const { text } = await run(pagedRepo(rows(3)));

    expect(text).toContain('body-0');
    expect(text).toContain('body-2');
    expect(text.toLowerCase()).not.toContain('excerpt');
    expect(warnedAboutTheBound()).toBe(false);
  });
});

describe('the coverage claim counts the FILE, not the scan', () => {
  it('treats a file with unsearchable chunks as a subset, not as complete', async () => {
    // 4 chunks in the file, only 2 carrying a vector. The reader filters the other two at the DB
    // layer, so counting what it returned would report a partial delivery as the whole file.
    const all = rows(4, i => (i < 2 ? [1, 0.5] : []));
    const { text } = await run(pagedRepo(all));

    expect(text).toContain('body-0');
    expect(text.toLowerCase()).toContain('excerpt');
  });

  it('reads the total from the chunk count, not from the rows it scored', async () => {
    const repo = pagedRepo(rows(3));

    await run(repo);

    expect(repo.countByFabFileId).toHaveBeenCalledWith('file-1');
  });

  it('still declares a subset when the count and the scan disagree', async () => {
    // The count and the scan are two separate queries, so a concurrent re-vectorization (delete then
    // re-insert) can leave the count lower than what the walk read. Here the count says 10 and the
    // walk delivers 10, which on the count alone looks like the whole file - but the scan was cut, so
    // it is not. This is the case the scan-truncation arm exists for.
    const { text } = await run(pagedRepo(rows(3000), 10));

    expect(text).toContain('Data for roster.csv:');
    expect(text.toLowerCase()).toContain('excerpt');
  });
});

describe('unusable chunks never silently zero the attachment', () => {
  it('skips a chunk whose vector width does not match the query', async () => {
    // Width mismatch means a different embedding model. computeCosineSimilarity returns 0 for it, and
    // a 0 is not a rejection - on a sparse file it would occupy a top-K slot with nothing useful.
    const all = [
      { id: 'chunk-000000', text: 'WRONG-WIDTH', vector: [0.1, 0.2, 0.3] },
      { id: 'chunk-000001', text: 'RIGHT-WIDTH', vector: [1, 0] },
    ];

    const { text } = await run(pagedRepo(all));

    expect(text).toContain('RIGHT-WIDTH');
    expect(text).not.toContain('WRONG-WIDTH');
  });

  it('skips a zero-magnitude vector rather than letting NaN outrank every real hit', async () => {
    // cosine of a zero vector is NaN, and NaN fails every comparison: it slips past a similarity
    // floor and then sorts ahead of real matches.
    const all = [
      { id: 'chunk-000000', text: 'NAN-CHUNK', vector: [0, 0] },
      { id: 'chunk-000001', text: 'REAL-CHUNK', vector: [1, 0] },
    ];

    const { text } = await run(pagedRepo(all));

    expect(text).toContain('REAL-CHUNK');
    expect(text).not.toContain('NAN-CHUNK');
  });

  it('hands over the file head unranked when nothing can be scored', async () => {
    // Every chunk embedded at another width, so no chunk is comparable. The text is still good, and
    // it must reach the model rather than being dropped for want of a score.
    const all = rows(3, () => [0.1, 0.2, 0.3]);

    const { text, errorMessages } = await run(pagedRepo(all));

    expect(text).toContain('body-0');
    expect(text).toContain('body-2');
    expect(errorMessages).toEqual([]);
  });

  it('does not depend on the raw reader for a format the raw reader cannot decode', async () => {
    // The load-bearing case for keeping the head: PPTX and XML are chunkable but getFileContent
    // throws on them, so routing an unscoreable-but-chunked file through raw content delivers nothing
    // at all - and the cosine arm has already cleared the file's error, so it reads as healthy.
    mockGetFileContent.mockRejectedValue(new Error('Unsupported file type: application/vnd.openxmlformats'));
    const all = rows(3, () => [0.1, 0.2, 0.3]);

    const { text } = await run(pagedRepo(all));

    expect(text).toContain('body-0');
  });

  it('falls back to raw content only when the file yielded no chunk at all', async () => {
    // Marked vectorized but the reader sees nothing: there is no head to hand over, so raw content is
    // the only route left.
    const { text } = await run(pagedRepo([]));

    expect(text).toContain('RAW-FILE-BODY');
  });

  it('does not tell the operator to vectorize a file that is already vectorized', async () => {
    // The raw-content arm's advice is written for an unvectorized file. Reaching it by fall-through
    // has to say what actually happened, or it sends someone chasing a vectorizing failure that
    // never occurred. Driven through the no-chunks route, which is the one that still reaches raw.
    mockGetFileContent.mockResolvedValue('X'.repeat(50_000));
    const fileUpdate = vi.fn();

    const { errorMessages } = await run(pagedRepo([]), { maxTokens: 1000, fileUpdate });

    const messages = errorMessages.map(m => String(m.content)).join('\n');
    expect(messages).toContain('exceeds');
    expect(messages).not.toContain('Vectorize your large file');
    expect(messages).toContain('embedding model');
    // Keeps the prefix the cosine arm clears, so the error goes away by itself once cosine works.
    const persisted = fileUpdate.mock.calls.map(c => String(c[0]?.error)).join('\n');
    expect(persisted).toContain('Knowledge in the workbench with the fileName');
  });
});
