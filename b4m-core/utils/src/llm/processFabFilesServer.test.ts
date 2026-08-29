import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CorruptedFileError, type IFabFileDocument, type ModelInfo } from '@bike4mind/common';
import { BadRequestError } from '../errors';

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
 * file ...") plus the anti-inference/truncation notices, none of which are charged
 * against the content budget. It is roughly a hundred characters per file against a
 * budget in the thousands, and assembly re-counts everything with the real tokenizer
 * afterwards, so it is allowed for rather than engineered away.
 */
const FRAMING_ALLOWANCE_PER_FILE = 300;

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

  it('lists every text file that was actually delivered, in full', async () => {
    const { deliveredFileIds, fullyDeliveredFileIds } = await processFabFilesServer(
      embeddingFactory,
      [textFile('a'), textFile('b')],
      'prompt',
      4000,
      modelInfo,
      async () => {},
      deps()
    );

    expect(deliveredFileIds.sort()).toEqual(['a', 'b']);
    // 'hello world' fits comfortably under the budget, so neither file was truncated.
    expect(fullyDeliveredFileIds.sort()).toEqual(['a', 'b']);
  });

  it('a raw-content file truncated to fit the token budget is delivered but not FULLY delivered', async () => {
    mockGetFileContent.mockResolvedValue('x'.repeat(50_000));

    const { deliveredFileIds, fullyDeliveredFileIds } = await processFabFilesServer(
      embeddingFactory,
      [textFile('big')],
      'prompt',
      // A tiny budget forces the raw-content truncation branch (see finalMaxFileSize).
      10,
      modelInfo,
      async () => {},
      deps()
    );

    expect(deliveredFileIds).toEqual(['big']);
    expect(fullyDeliveredFileIds).toEqual([]);
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

    const { deliveredFileIds, fullyDeliveredFileIds, userMessages } = await processFabFilesServer(
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
    expect(fullyDeliveredFileIds).toEqual(['good']);
    expect(emittedChars(userMessages)).toBeGreaterThan(0);
  });
});

describe('filename handling in the delivered-content wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFileContent.mockResolvedValue('some file content');
  });

  it('keeps digits in a filename out of the wrapper header un-flagged', async () => {
    // A number embedded in the filename (e.g. 30000.txt) sits right next to the content; the model
    // must be told it is part of the name, not a row/record count it can echo back.
    const { userMessages } = await processFabFilesServer(
      embeddingFactory,
      [textFile('30000')],
      'prompt',
      4000,
      modelInfo,
      async () => {},
      deps()
    );

    const content = userMessages[0].content as string;
    expect(content).toContain('Here is the content from the attached file "30000.txt" for context:');
    expect(content).toContain(
      'Digits in the file name are part of the name, not a count of its rows, records, or sections.'
    );
  });

  it('sanitizes bracket and quote characters out of the wrapper header filename', async () => {
    const crafted = {
      id: 'a',
      fileName: 'weird[1]"name.txt',
      mimeType: 'text/plain',
      vectorized: false,
    } as IFabFileDocument;
    const { userMessages } = await processFabFilesServer(
      embeddingFactory,
      [crafted],
      'prompt',
      4000,
      modelInfo,
      async () => {},
      deps()
    );

    const content = userMessages[0].content as string;
    expect(content).not.toContain('weird[1]"name.txt');
    expect(content).toContain('weird 1  name.txt');
  });

  it('falls back to a placeholder when sanitizing empties the filename', async () => {
    const crafted = { id: 'a', fileName: '["]', mimeType: 'text/plain', vectorized: false } as IFabFileDocument;
    const { userMessages } = await processFabFilesServer(
      embeddingFactory,
      [crafted],
      'prompt',
      4000,
      modelInfo,
      async () => {},
      deps()
    );

    const content = userMessages[0].content as string;
    expect(content).toContain('Here is the content from the attached file "unnamed attachment" for context:');
  });

  it('states the digit-in-filename caveat once, not per file, when multiple files are attached', async () => {
    const { userMessages } = await processFabFilesServer(
      embeddingFactory,
      [textFile('30000'), textFile('40000')],
      'prompt',
      4000,
      modelInfo,
      async () => {},
      deps()
    );

    const content = userMessages[0].content as string;
    const occurrences = content.split('Digits in the file name are part of the name').length - 1;
    expect(occurrences).toBe(1);
    expect(content).toContain('--- File 1: 30000.txt ---');
    expect(content).toContain('--- File 2: 40000.txt ---');
  });
});

/**
 * The acceptance criterion for #2228: an attachment either reaches the model or says why it did not.
 * Most of these sites used to return with nothing pushed at all, so the caller had nothing to report
 * even before it commented the destructure out - which is why the sweep at the end matters more than
 * any single site.
 */
describe('processFabFilesServer file notices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFileContent.mockResolvedValue('some file content');
  });

  const run = async (files: IFabFileDocument[], budget = 4000, info: ModelInfo = modelInfo) =>
    processFabFilesServer(embeddingFactory, files, 'prompt', budget, info, async () => {}, deps());

  it('reports an audio attachment as undelivered', async () => {
    const audio = {
      id: 'aud',
      fileName: 'bark.mp3',
      mimeType: 'audio/mpeg',
      vectorized: false,
    } as IFabFileDocument;

    const { fileNotices, deliveredFileIds } = await run([audio]);

    expect(deliveredFileIds).toEqual([]);
    expect(fileNotices).toEqual([
      expect.objectContaining({ fabFileId: 'aud', band: 'audio', delivered: false }),
    ]);
    expect(fileNotices[0].message).toContain('bark.mp3');
  });

  it('reports an image held pending moderation as undelivered', async () => {
    const held = {
      id: 'held',
      fileName: 'held.png',
      mimeType: 'image/png',
      moderationStatus: 'pending',
      vectorized: false,
    } as unknown as IFabFileDocument;
    const visionModel = { id: 'gpt-4o', supportsVision: true, backend: 'openai' } as unknown as ModelInfo;

    const { fileNotices } = await run([held], 4000, visionModel);

    expect(fileNotices).toEqual([
      expect.objectContaining({ fabFileId: 'held', band: 'image_not_serveable', delivered: false }),
    ]);
  });

  it('reports an image handed to a model that cannot read images', async () => {
    const { fileNotices } = await run([imageFile('img')]);

    expect(fileNotices).toEqual([
      expect.objectContaining({ fabFileId: 'img', band: 'vision_unsupported', delivered: false }),
    ]);
  });

  it('reports an unsupported file type', async () => {
    mockGetFileContent.mockRejectedValue(new BadRequestError('Unsupported file type: application/x-thing'));

    const { fileNotices, deliveredFileIds } = await run([textFile('odd')]);

    expect(deliveredFileIds).toEqual([]);
    expect(fileNotices).toEqual([
      expect.objectContaining({ fabFileId: 'odd', band: 'unsupported_type', delivered: false }),
    ]);
  });

  it('reports a corrupted read while a sibling file still delivers', async () => {
    mockGetFileContent.mockImplementation(async (file: IFabFileDocument) => {
      if (file.id === 'bad') throw new CorruptedFileError(file.fileName, 'PDF', 'unreadable stream');
      return 'hello world';
    });

    const { fileNotices, deliveredFileIds } = await run([textFile('good'), textFile('bad')]);

    // One unreadable attachment must not cost the turn its other attachments.
    expect(deliveredFileIds).toEqual(['good']);
    expect(fileNotices).toEqual([
      expect.objectContaining({ fabFileId: 'bad', band: 'read_failed', delivered: false }),
    ]);
  });

  it('reports an image on a backend that takes no image payload', async () => {
    const storage = { download: vi.fn(), getSignedUrl: vi.fn().mockResolvedValue('https://signed') };
    const withPath = {
      ...imageFile('img'),
      filePath: 'uploads/img.png',
    } as IFabFileDocument;
    const unsupportedBackend = { id: 'x', supportsVision: true, backend: 'made-up' } as unknown as ModelInfo;

    const { fileNotices, deliveredFileIds } = await processFabFilesServer(
      embeddingFactory,
      [withPath],
      'prompt',
      4000,
      unsupportedBackend,
      async () => {},
      {
        ...deps(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal shapes for the signed-url arm
        storage: storage as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- getCachedSignedUrl reads/writes this
        db: { ...deps().db, caches: { findByKey: vi.fn(), createOrUpdate: vi.fn() } } as any,
      }
    );

    expect(deliveredFileIds).toEqual([]);
    expect(fileNotices).toEqual([
      expect.objectContaining({ fabFileId: 'img', band: 'unsupported_backend', delivered: false }),
    ]);
  });

  it('leaves no input file both undelivered and unreported, whatever mix is attached', async () => {
    // The property the per-site pushes and the post-processing sweep exist to hold jointly. Asserted
    // over a mixed batch rather than per site, because the defect is a file falling between them.
    mockGetFileContent.mockImplementation(async (file: IFabFileDocument) => {
      if (file.id === 'odd') throw new BadRequestError('Unsupported file type: application/x-thing');
      return 'hello world';
    });
    const audio = { id: 'aud', fileName: 'a.mp3', mimeType: 'audio/mpeg', vectorized: false } as IFabFileDocument;
    const files = [textFile('good'), textFile('odd'), audio, imageFile('img')];

    const { fileNotices, deliveredFileIds } = await run(files);

    const accountedFor = new Set([...deliveredFileIds, ...fileNotices.map(n => n.fabFileId)]);
    expect(files.every(f => accountedFor.has(f.id))).toBe(true);
    expect(deliveredFileIds).toEqual(['good']);
  });

  it('marks a truncated file as delivered and keeps it out of fullyDeliveredFileIds', async () => {
    mockGetFileContent.mockResolvedValue('X'.repeat(50_000));

    const { fileNotices, deliveredFileIds, fullyDeliveredFileIds, userMessages } = await run([textFile('big')], 1000);

    expect(deliveredFileIds).toEqual(['big']);
    expect(fullyDeliveredFileIds).toEqual([]);
    expect(fileNotices).toEqual([
      expect.objectContaining({ fabFileId: 'big', band: 'truncated', delivered: true }),
    ]);
    // The in-band notice the model reads is unchanged - the new channel is additive.
    expect(emittedChars(userMessages)).toBeGreaterThan(0);
    expect(userMessages.map(m => String(m.content)).join('\n')).toContain('[Content truncated to fit the context window.');
  });

  it('emits no notice when every attachment delivers whole', async () => {
    const { fileNotices, fullyDeliveredFileIds } = await run([textFile('a'), textFile('b')]);

    expect(fileNotices).toEqual([]);
    expect(fullyDeliveredFileIds).toEqual(expect.arrayContaining(['a', 'b']));
  });
});
