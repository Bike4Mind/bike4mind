import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CorruptedFileError, type IFabFileDocument, type ModelInfo } from '@bike4mind/common';

const mockGetFileContent = vi.fn();
vi.mock('../fabfile', () => ({ getFileContent: (...a: unknown[]) => mockGetFileContent(...a) }));

import { processFabFilesServer } from './utils';

const CHARS_PER_TOKEN = 3.5;
const MAX_FILE_SIZE = 6000;

const logger = { info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const textFile = (id: string): IFabFileDocument =>
  ({ id, fileName: `${id}.txt`, mimeType: 'text/plain', vectorized: false }) as IFabFileDocument;
const imageFile = (id: string): IFabFileDocument =>
  ({
    id,
    fileName: `${id}.png`,
    mimeType: 'image/png',
    vectorized: false,
    moderationStatus: 'clean',
  }) as IFabFileDocument;

// Non-vision so images take the "skip" arm and never need storage/base64 plumbing.
const modelInfo = { id: 'm', supportsVision: false, backend: 'openai' } as unknown as ModelInfo;

const embeddingFactory = {
  getDefaultEmbeddingModel: () => 'text-embedding-3-small',
  createEmbeddingService: () => ({
    getModelInfo: () => ({ model: 'text-embedding-3-small', contextWindow: 8191 }),
    generateEmbedding: async () => [0.1, 0.2],
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal factory shape for this unit test
} as any;

// Models an embedding outage: the provider rejects every embed call (e.g. a 401 on a revoked or
// endpoint-scoped key). The query embedding must degrade to raw content, not abort the whole turn.
const throwingEmbeddingFactory = {
  getDefaultEmbeddingModel: () => 'text-embedding-3-small',
  createEmbeddingService: () => ({
    getModelInfo: () => ({ model: 'text-embedding-3-small', contextWindow: 8191 }),
    generateEmbedding: async () => {
      throw new Error('OpenAI rejected the embedding request (401 Unauthorized)');
    },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal factory shape for this unit test
} as any;

const vectorizedTextFile = (id: string, embeddingModel = 'text-embedding-ada-002'): IFabFileDocument =>
  ({ id, fileName: `${id}.txt`, mimeType: 'text/plain', vectorized: true, embeddingModel }) as IFabFileDocument;

const deps = () => ({
  logger: logger as never,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage is unused on the raw-content path
  storage: {} as any,
  db: {
    fabfilechunks: {
      findVectorsByFabFileIds: vi.fn().mockResolvedValue([]),
      countByFabFileId: vi.fn().mockResolvedValue(0),
    },
    fabfiles: { update: vi.fn().mockResolvedValue(undefined) },
    caches: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape
  } as any,
});

/** Total characters emitted, including each file's framing prose. */
const emittedChars = (userMessages: Array<{ content: unknown }>) =>
  userMessages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);

/**
 * Each included file carries a short label ("Here is the content from the attached
 * file ...") that is not charged against the content budget. It is tens of characters
 * per file against a budget in the thousands, and assembly re-counts everything with
 * the real tokenizer afterwards, so it is allowed for rather than engineered away.
 */
const FRAMING_ALLOWANCE_PER_FILE = 200;

describe('processFabFilesServer attached-content budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFileContent.mockResolvedValue('C'.repeat(100_000));
  });

  it('divides the budget across text files instead of giving each the full allowance', async () => {
    // Without the divisor the per-file char cap is applied N times over, so four files
    // would emit four times the budget. This is the bound that makes raising the budget
    // safe at all.
    const budget = 4000;
    const { userMessages } = await processFabFilesServer(
      embeddingFactory,
      ['a', 'b', 'c', 'd'].map(textFile),
      'prompt',
      budget,
      modelInfo,
      async () => {},
      deps()
    );

    expect(emittedChars(userMessages)).toBeLessThanOrEqual(budget * CHARS_PER_TOKEN + 4 * FRAMING_ALLOWANCE_PER_FILE);
  });

  it('ignores images when splitting the text budget', async () => {
    // Images do not consume the text budget, so counting them would shrink every text
    // file's share for no reason.
    const budget = 2000;
    const withImages = await processFabFilesServer(
      embeddingFactory,
      [textFile('a'), textFile('b'), imageFile('i1'), imageFile('i2')],
      'prompt',
      budget,
      modelInfo,
      async () => {},
      deps()
    );
    const withoutImages = await processFabFilesServer(
      embeddingFactory,
      [textFile('a'), textFile('b')],
      'prompt',
      budget,
      modelInfo,
      async () => {},
      deps()
    );

    expect(emittedChars(withImages.userMessages)).toBe(emittedChars(withoutImages.userMessages));
  });

  it('scales with the budget it is given, rather than a fixed cap', async () => {
    const small = await processFabFilesServer(
      embeddingFactory,
      [textFile('a')],
      'prompt',
      1000,
      modelInfo,
      async () => {},
      deps()
    );
    const large = await processFabFilesServer(
      embeddingFactory,
      [textFile('a')],
      'prompt',
      8000,
      modelInfo,
      async () => {},
      deps()
    );

    expect(emittedChars(large.userMessages)).toBeGreaterThan(emittedChars(small.userMessages));
  });

  it('still emits raw content when the query embedding fails, instead of throwing', async () => {
    // The E2E regression: a 401 on the up-front query embedding must not abort file processing.
    // A non-vectorized file has always used the raw-content path, so the only thing that could
    // sink it is the query embedding throwing before the file loop - which this guards against.
    const { userMessages } = await processFabFilesServer(
      throwingEmbeddingFactory,
      [textFile('a')],
      'prompt',
      4000,
      modelInfo,
      async () => {},
      deps()
    );

    expect(emittedChars(userMessages)).toBeGreaterThan(0);
  });

  it('falls back to raw content for a vectorized file when the query embedding fails', async () => {
    // Previously a vectorized file with no usable query vector was dropped outright (an early
    // return), so an embedding outage silently removed the attachment. It must now raw-read.
    const { userMessages } = await processFabFilesServer(
      throwingEmbeddingFactory,
      [vectorizedTextFile('a')],
      'prompt',
      4000,
      modelInfo,
      async () => {},
      deps()
    );

    expect(emittedChars(userMessages)).toBeGreaterThan(0);
  });

  it('raw-reads a vectorized file whose embedding model differs from this turn default', async () => {
    // Even with a healthy embedder, a file stored under a different model than the turn's default
    // has no matching query vector. That is not a reason to drop it - it raw-reads instead.
    const { userMessages } = await processFabFilesServer(
      embeddingFactory, // healthy: query embeds as 'text-embedding-3-small'
      [vectorizedTextFile('a', 'text-embedding-ada-002')], // stored under a different model
      'prompt',
      4000,
      modelInfo,
      async () => {},
      deps()
    );

    expect(emittedChars(userMessages)).toBeGreaterThan(0);
  });

  it('does not restore the flat per-file cap when the budget is zero', async () => {
    // The trap: the char caps read a non-positive budget as "no budget supplied" and
    // fall back to MAX_FILE_SIZE *per file*. With three files that is 18k characters,
    // which on the small-context models that actually produce a zero budget exceeds the
    // entire input window. A single-file test passes either way, so this uses three.
    const { userMessages } = await processFabFilesServer(
      embeddingFactory,
      [textFile('a'), textFile('b'), textFile('c')],
      'prompt',
      0,
      modelInfo,
      async () => {},
      deps()
    );

    expect(emittedChars(userMessages)).toBeLessThan(MAX_FILE_SIZE);
  });
});

/**
 * #1163: `deliveredFileIds` must name only files that actually contributed content, not every
 * file this call was given - a caller (e.g. a knowledge tool telling the model "this file's
 * content is already above") trusting the input list instead would assert something false about
 * a silently-skipped file.
 */
describe('processFabFilesServer deliveredFileIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFileContent.mockResolvedValue('hello world');
  });

  it('lists every text file that was actually delivered', async () => {
    const { deliveredFileIds } = await processFabFilesServer(
      embeddingFactory,
      [textFile('a'), textFile('b')],
      'prompt',
      4000,
      modelInfo,
      async () => {},
      deps()
    );

    expect(deliveredFileIds.sort()).toEqual(['a', 'b']);
  });

  it('excludes an image skipped because the model does not support vision', async () => {
    const { deliveredFileIds, userMessages } = await processFabFilesServer(
      embeddingFactory,
      [textFile('a'), imageFile('img-1')],
      'prompt',
      4000,
      modelInfo, // supportsVision: false
      async () => {},
      deps()
    );

    // Sanity: the image really did take the silent-skip arm, not an error path.
    expect(userMessages.some(m => typeof m.content === 'string' && m.content.includes('img-1'))).toBe(false);
    expect(deliveredFileIds).toEqual(['a']);
  });

  it('excludes a corrupted file from delivery while a sibling file still succeeds', async () => {
    // Only this one file's read fails - a shared per-turn mock keyed by call order would let
    // the corrupted file "succeed" on retry via cache reuse, so key it by filename instead.
    mockGetFileContent.mockImplementation(async (file: IFabFileDocument) => {
      if (file.id === 'bad') throw new CorruptedFileError(file.fileName, 'PDF', 'unreadable stream');
      return 'hello world';
    });

    const { deliveredFileIds, userMessages } = await processFabFilesServer(
      embeddingFactory,
      [textFile('good'), textFile('bad')],
      'prompt',
      4000,
      modelInfo,
      async () => {},
      deps()
    );

    // The corrupted file is silently skipped (caught, not rethrown) - the turn as a whole
    // still succeeds and the sibling file's content still reaches the model.
    expect(deliveredFileIds).toEqual(['good']);
    expect(emittedChars(userMessages)).toBeGreaterThan(0);
  });
});
