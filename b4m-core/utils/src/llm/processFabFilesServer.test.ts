import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IFabFileDocument, ModelInfo } from '@bike4mind/common';

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

const deps = () => ({
  logger: logger as never,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage is unused on the raw-content path
  storage: {} as any,
  db: {
    fabfilechunks: { findByFabFileId: vi.fn().mockResolvedValue([]) },
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
