import { describe, it, expect, vi, beforeEach } from 'vitest';

// Content is cut in three places. Assembly's own cut is covered in utils.test.ts; these are the two
// stages UPSTREAM of it, which used to hand assembly a fragment that looked complete. Both need their
// own module mocks (file storage, URL fetch), so they live in their own file rather than forcing a
// module mock on the 500-test suite next door.
vi.mock('../fabfile', async importOriginal => ({
  ...(await importOriginal<typeof import('../fabfile')>()),
  getFileContent: vi.fn(async () => 'ROW-START,' + 'x'.repeat(40000) + ',ROW-END'),
}));

vi.mock('@bike4mind/fab-pipeline', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/fab-pipeline')>()),
  fetchAndParseURL: vi.fn(async () => ({ textContent: 'PAGE-START ' + 'y'.repeat(40000) + ' PAGE-END' })),
}));

import { processFabFilesServer, processUrlsFromPrompt, buildAndSortMessages, getLastBuildDebugInfo } from './utils';

const mockLogger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  updateMetadata: vi.fn(),
};

const TRUNCATION_NOTICE_MARKER = '[Content truncated to fit the context window';
const EXCERPT_MARKER = 'most relevant excerpts from';
const URL_NOTICE_MARKER = 'Fetched page content truncated';

const tokenizer = {
  countTokens: vi.fn(async (t: string) => Math.ceil(t.length / 3.5)),
  encodeTokens: vi.fn(async (t: string) => Array(Math.ceil(t.length / 3.5)).fill(1)),
  clearCache: vi.fn(),
  getCacheStats: vi.fn(() => ({ size: 0, keys: [] })),
  warmUpCache: vi.fn(async () => {}),
};

const warnings = () => (mockLogger.warn.mock.calls as unknown[][]).map(c => String(c[0])).join('\n');

const embeddingFactory = {
  getDefaultEmbeddingModel: () => 'text-embedding-ada-002',
  createEmbeddingService: () => ({
    getModelInfo: () => ({ model: 'text-embedding-ada-002', contextWindow: 8192 }),
    generateEmbedding: async () => [1, 0],
  }),
};

const chunks = (count: number, charsEach: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `chunk-${i}`,
    text: `chunk-${i}-` + 'c'.repeat(Math.max(0, charsEach - `chunk-${i}-`.length)),
    vector: [1, i / count],
  }));

/** Similarity order is the REVERSE of document order, so presentation order is observable. */
const reverseRankedChunks = (count: number, charsEach: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `chunk-${i}`,
    text: `chunk-${i}-` + 'c'.repeat(Math.max(0, charsEach - `chunk-${i}-`.length)),
    vector: [1, (count - i) / count],
  }));

const runFabFiles = async (
  file: Record<string, unknown>,
  maxTokens: number,
  fileChunks: ReturnType<typeof chunks> = []
) => {
  const { userMessages } = await processFabFilesServer(
    embeddingFactory as any,
    [{ id: 'file-1', fileName: 'roster.csv', mimeType: 'text/csv', ...file } as any],
    'who is on the roster',
    maxTokens,
    { supportsVision: false } as any,
    async () => {},
    {
      logger: mockLogger as any,
      storage: {} as any,
      db: {
        fabfilechunks: { findByFabFileId: vi.fn(async () => fileChunks) },
        fabfiles: { update: vi.fn() },
        caches: {} as any,
      } as any,
    }
  );
  return userMessages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
};

describe('content cut before assembly is declared to the model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('raw extraction head slice', () => {
    it('marks a file that exceeded its per-file budget', async () => {
      // 40k chars against a 1000-token budget (3500 chars). Assembly cannot tell this from a whole
      // file, so before this the model presented the slice as complete and named a mid-file row last.
      const content = await runFabFiles({ vectorized: false }, 1000);

      expect(content).toContain('ROW-START');
      expect(content).not.toContain('ROW-END');
      expect(content).toContain(TRUNCATION_NOTICE_MARKER);
    });

    it('says nothing when the file fits whole', async () => {
      // The healthy path has to stay silent, or the notice becomes noise the model learns to ignore.
      const content = await runFabFiles({ vectorized: false }, 100000);

      expect(content).toContain('ROW-END');
      expect(content).not.toContain(TRUNCATION_NOTICE_MARKER);
    });
  });

  describe('similarity-ranked excerpts', () => {
    it('tells the model when it is holding a subset of the chunks', async () => {
      // 40 chunks, top 10 retrieved: non-contiguous AND score-ordered, so the model must not read a
      // row count or a final row off it. This is what let a 19-row slice of 753 rows pass as the file.
      const content = await runFabFiles({ vectorized: true, embeddingModel: 'text-embedding-ada-002' }, 4000, chunks(40, 100));

      expect(content).toContain('Data for roster.csv:');
      expect(content).toContain(EXCERPT_MARKER);
      expect(content).toMatch(/NOT contiguous/);
      expect(warnings()).toContain('similarity-ranked excerpts');
    });

    it('says nothing when every chunk is delivered intact', async () => {
      const content = await runFabFiles({ vectorized: true, embeddingModel: 'text-embedding-ada-002' }, 4000, chunks(4, 100));

      for (let i = 0; i < 4; i++) expect(content).toContain(`chunk-${i}-`);
      expect(content).not.toContain(EXCERPT_MARKER);
      expect(warnings()).not.toContain('similarity-ranked excerpts');
    });

    it('marks a subset when the budget cut the only chunk, so no chunk was dropped', async () => {
      // One oversized chunk: it is delivered, nothing is dropped, so the delivered-count test alone
      // reads this as the whole file. The cut itself is the only evidence, which is why it is tracked.
      const content = await runFabFiles({ vectorized: true, embeddingModel: 'text-embedding-ada-002' }, 100, chunks(1, 3000));

      expect(content).toContain('chunk-0-');
      expect(content).toContain(EXCERPT_MARKER);
    });
  });

  describe('excerpt presentation order', () => {
    it('presents the selected chunks in file order, not similarity order', async () => {
      // Ranking picks the top 10 of 20; scores here run opposite to document order, so score-ordered
      // output would start at the highest index. A scrambled file is one of the ways the model ends up
      // naming a mid-file row as the last, and it happened even when every chunk was delivered.
      const content = await runFabFiles(
        { vectorized: true, embeddingModel: 'text-embedding-ada-002' },
        4000,
        reverseRankedChunks(20, 100)
      );

      const order = (content.match(/chunk-(\d+)-/g) || []).map(m => Number(m.match(/\d+/)![0]));
      expect(order.length).toBeGreaterThan(1);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('keeps a fully delivered file in file order too', async () => {
      const content = await runFabFiles(
        { vectorized: true, embeddingModel: 'text-embedding-ada-002' },
        4000,
        reverseRankedChunks(6, 100)
      );

      const order = (content.match(/chunk-(\d+)-/g) || []).map(m => Number(m.match(/\d+/)![0]));
      expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    });
  });

  describe('an upstream notice survives a later assembly cut', () => {
    it('keeps the excerpt wording instead of replacing it with the head-slice wording', async () => {
      // Assembly's cut slices the tail, taking the excerpt notice with it, and used to append the
      // generic notice in its place - telling the model the content simply stops here, which is the
      // exact inference the excerpt notice exists to block. Reachable when excerpts alone exceed the
      // content budget, i.e. a small window with large embeddings.
      const excerpts = await runFabFiles(
        { vectorized: true, embeddingModel: 'text-embedding-ada-002' },
        4000,
        chunks(40, 400)
      );
      expect(excerpts).toContain(EXCERPT_MARKER);

      const assembled = await buildAndSortMessages(
        [],
        [{ role: 'user', content: excerpts }],
        [{ role: 'user', content: 'what does it say' }],
        1800,
        {},
        5,
        mockLogger as any,
        tokenizer as any
      );
      const body = assembled.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');

      expect(body).toContain('do not infer a total row');
      expect(body).not.toContain('This is NOT the end of the file');
      // And no fragment of the excerpt notice left dangling beside another one.
      expect(body.split('most relevant excerpts from').length - 1).toBe(1);
    });
  });

  describe('telemetry for a budget-driven history cut', () => {
    it('reports token-budget, not history-limit, when history is cut mid-message', async () => {
      // The truncation fallback shrinks history in place and returns removedMessages: [], so the
      // history calls discarded the only evidence and a budget loss was labelled as configured
      // windowing.
      await buildAndSortMessages(
        Array.from({ length: 6 }, (_, i) => ({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `history message ${i} ` + 'h'.repeat(3000),
        })),
        [],
        [{ role: 'user', content: 'carry on' }],
        // 1800 not 2000: at 2000 one history message still fits, so messages get DROPPED and
        // removedMessages alone would flag the budget loss. Below that nothing fits, the fallback
        // shrinks all six in place, and the mid-message signal is the only evidence there is.
        1800,
        {},
        5,
        mockLogger as any,
        tokenizer as any
      );

      const debug = getLastBuildDebugInfo();
      expect(debug?.wasTruncated).toBe(true);
      expect(debug?.truncationMethod).toBe('token-budget');
    });
  });

  describe('fetched URL content', () => {
    it('marks and logs a truncated page, which had no signal of any kind', async () => {
      const { userMessages } = await processUrlsFromPrompt(
        'summarise https://example.com/report',
        2000,
        'user-1',
        async () => {},
        mockLogger as any
      );
      const content = userMessages.map(m => String(m.content)).join('\n');

      expect(content).toContain('PAGE-START');
      expect(content).not.toContain('PAGE-END');
      expect(content).toContain(URL_NOTICE_MARKER);
      expect(warnings()).toContain('Truncated fetched content');
    });

    it('says nothing when the page fits whole', async () => {
      const { userMessages } = await processUrlsFromPrompt(
        'summarise https://example.com/report',
        100000,
        'user-1',
        async () => {},
        mockLogger as any
      );
      const content = userMessages.map(m => String(m.content)).join('\n');

      expect(content).toContain('PAGE-END');
      expect(content).not.toContain(URL_NOTICE_MARKER);
      expect(warnings()).not.toContain('Truncated fetched content');
    });
  });
});
