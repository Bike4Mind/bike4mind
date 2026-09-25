import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import {
  SmartChunker,
  Chunk,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  MIN_PASSAGE_TOKEN_TARGET,
  effectiveChunkTokenLimit,
  embeddingModelContextWindow,
} from './chunk';
import { Logger } from '@bike4mind/observability';
import { countCodePoints, DocumentDateSource, MIN_CHUNK_CHARS_FLOOR } from '@bike4mind/common';

/**
 * Forces `getMetadata()` to reject on the next PDF opened, so the guard in `readPdfDocumentDate`
 * can be driven. A fixture cannot reach it: pdf.js recovers from a missing, non-dictionary or
 * malformed Info entry and returns an empty info object rather than raising.
 */
const pdfMetadataFailure = vi.hoisted(() => ({ message: null as string | null }));

/**
 * Forces `JSZip.loadAsync` to reject on the next container opened, so the guards in
 * `readWorkbookDocumentDate` and `openOoxmlContainerForDate` can be driven. A fixture cannot reach
 * these: any buffer a real writer (xlsx, mammoth's own docx builder) produces is one JSZip opens
 * fine, so only the container's own EXISTING entries can be damaged in place - never the open call
 * itself. Only `loadAsync` is patched; every other export, including the `JSZip` class the fixture
 * builders construct with `new`, is the real library.
 */
const jsZipLoadFailure = vi.hoisted(() => ({ message: null as string | null }));

vi.mock('jszip', async importOriginal => {
  const actual = await importOriginal<typeof import('jszip')>();
  const RealJSZip = actual.default;
  class PatchedJSZip extends RealJSZip {
    static loadAsync(...args: Parameters<(typeof RealJSZip)['loadAsync']>) {
      const message = jsZipLoadFailure.message;
      if (message) return Promise.reject(new Error(message));
      return RealJSZip.loadAsync(...args);
    }
  }
  return { ...actual, default: PatchedJSZip };
});

// Passthrough by default, so every other PDF test in this file still drives the REAL unpdf reader.
vi.mock('unpdf', async importOriginal => {
  const actual = await importOriginal<typeof import('unpdf')>();
  return {
    ...actual,
    getDocumentProxy: async (...args: Parameters<typeof actual.getDocumentProxy>) => {
      const proxy = await actual.getDocumentProxy(...args);
      const message = pdfMetadataFailure.message;
      if (!message) return proxy;
      return new Proxy(proxy, {
        // Methods are bound to the real proxy: pdf.js instances carry private fields, so calling
        // one with `this` set to the Proxy would throw for a reason unrelated to this test.
        get(target, prop) {
          if (prop === 'getMetadata') return () => Promise.reject(new Error(message));
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

// Minimal mock storage - chunkText doesn't use storage
const mockStorage = {
  getContentAsBuffer: async () => Buffer.from(''),
};

const MODEL = 'text-embedding-3-small' as any;
// text-embedding-3-small has 8192 max tokens.
// Set chunkTokenLimit to 300 by using bufferPercentOrValue = 8192 - 300 = 7892
// Since bufferPercentOrValue >= 1, it's treated as absolute buffer value.
const CHUNK_TOKEN_LIMIT = 300;

function createChunker(chunkTokenLimit = CHUNK_TOKEN_LIMIT): SmartChunker {
  const logger = new Logger({ component: 'chunk-test' });
  // buffer = maxTokens - chunkTokenLimit = 8192 - chunkTokenLimit
  const buffer = 8192 - chunkTokenLimit;
  return new SmartChunker(MODEL, mockStorage, logger, buffer);
}

// text-embedding-3-small: 8192-token window. Default 20% buffer => floor(8192*0.2)=1638, so the
// hard limit a passage target is capped to is 8192 - 1638 = 6554.
const MODEL_WINDOW = 8192;
const DEFAULT_BUFFERED_HARD_LIMIT = MODEL_WINDOW - Math.floor(MODEL_WINDOW * 0.2); // 6554

describe('embeddingModelContextWindow', () => {
  it('returns the model window for a supported model', () => {
    expect(embeddingModelContextWindow('text-embedding-3-small')).toBe(MODEL_WINDOW);
  });

  it('throws on an unsupported model (matching the chunker)', () => {
    expect(() => embeddingModelContextWindow('not-a-real-model')).toThrow(/Unsupported embedding model/);
  });
});

describe('effectiveChunkTokenLimit', () => {
  const model = 'text-embedding-3-small';

  it('passes a passage target through unchanged when it fits under the buffered window', () => {
    expect(effectiveChunkTokenLimit({ model, passageTokenTarget: 512 })).toBe(512);
  });

  it('falls back to the default when no target is supplied', () => {
    expect(effectiveChunkTokenLimit({ model })).toBe(DEFAULT_PASSAGE_TOKEN_TARGET);
  });

  it('floors a below-minimum target to MIN_PASSAGE_TOKEN_TARGET', () => {
    expect(effectiveChunkTokenLimit({ model, passageTokenTarget: 1 })).toBe(MIN_PASSAGE_TOKEN_TARGET);
  });

  it('caps a target larger than the model can embed to the buffered window (#1662 clamp)', () => {
    expect(effectiveChunkTokenLimit({ model, passageTokenTarget: 100_000 })).toBe(DEFAULT_BUFFERED_HARD_LIMIT);
  });

  it('two over-window targets clamp to the SAME effective limit (so they never false-conflict)', () => {
    const a = effectiveChunkTokenLimit({ model, passageTokenTarget: 100_000 });
    const b = effectiveChunkTokenLimit({ model, passageTokenTarget: 50_000 });
    expect(a).toBe(b);
  });

  it('treats a non-finite/negative target as absent (default)', () => {
    expect(effectiveChunkTokenLimit({ model, passageTokenTarget: -5 })).toBe(DEFAULT_PASSAGE_TOKEN_TARGET);
    expect(effectiveChunkTokenLimit({ model, passageTokenTarget: Number.NaN })).toBe(DEFAULT_PASSAGE_TOKEN_TARGET);
  });
});

describe('SmartChunker', () => {
  let chunker: SmartChunker;

  beforeEach(() => {
    chunker = createChunker();
  });

  afterEach(() => {
    chunker.freeEncoder();
  });

  // Fab-file content is untrusted, and a tiktoken special-token literal inside it used to make the
  // encoder reject - failing the ingest of the whole file over one string in it.
  describe('chunkText - special-token literals in file content', () => {
    const LITERAL = '<|endoftext|>';

    it('counts a literal as characters rather than rejecting it', async () => {
      await expect((chunker as any).countTokens(`what does ${LITERAL} mean`)).resolves.toBeGreaterThan(1);
    });

    it('round-trips encode -> decode through a literal', async () => {
      // splitOversizedSegment slices encoded ids and decodes them back, so the pair has to survive
      // the literal, not just the count.
      const text = `keep ${LITERAL} intact`;
      const ids = await (chunker as any).encodeTokens(text);

      expect(ids.length).toBeGreaterThan(1);
      await expect((chunker as any).decodeTokens(ids)).resolves.toBe(text);
    });

    it('chunks a document containing literals', async () => {
      const text = `Section one discusses ${LITERAL} and how the pipeline handles it. `.repeat(40);
      const chunks: Chunk[] = await (chunker as any).chunkText(text);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map(c => c.text).join('')).toContain(LITERAL);
      for (const chunk of chunks) {
        const actualTokens = await (chunker as any).countTokens(chunk.text);
        expect(actualTokens).toBeLessThanOrEqual(CHUNK_TOKEN_LIMIT);
      }
    });
  });

  describe('chunkText — oversized word fallback', () => {
    it('splits text with no punctuation (single giant "sentence")', async () => {
      // 2000 words, no sentence-ending punctuation
      const words = Array.from({ length: 2000 }, (_, i) => `word${i}`);
      const text = words.join(' ');
      const chunks = await (chunker as any).chunkText(text);

      for (const chunk of chunks) {
        const actualTokens = await (chunker as any).countTokens(chunk.text);
        expect(actualTokens).toBeLessThanOrEqual(CHUNK_TOKEN_LIMIT);
      }
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('splits text with no whitespace (single giant "word")', { timeout: 30000 }, async () => {
      // A long string with no spaces or punctuation - triggers the encode-slice-decode fallback
      const text = 'a'.repeat(10000);
      const chunks = await (chunker as any).chunkText(text);

      for (const chunk of chunks) {
        const actualTokens = await (chunker as any).countTokens(chunk.text);
        expect(actualTokens).toBeLessThanOrEqual(CHUNK_TOKEN_LIMIT);
      }
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('splits text with no punctuation AND no whitespace', async () => {
      // Mixed characters, no spaces, no punctuation
      const text = 'abcdefghij0123456789'.repeat(5000);
      const chunks = await (chunker as any).chunkText(text);

      for (const chunk of chunks) {
        const actualTokens = await (chunker as any).countTokens(chunk.text);
        expect(actualTokens).toBeLessThanOrEqual(CHUNK_TOKEN_LIMIT);
      }
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('handles single word just over chunkTokenLimit tokens (boundary)', async () => {
      // Use varied characters so tiktoken doesn't compress too aggressively.
      // Each unique char pair ~1 token in cl100k_base. We need > 300 tokens.
      let text = '';
      for (let i = 0; i < 2000; i++) {
        text += String.fromCharCode(65 + (i % 26)) + String.fromCharCode(97 + ((i * 7) % 26));
      }
      // Verify it actually exceeds the limit
      const tokenCount = await (chunker as any).countTokens(text);
      expect(tokenCount).toBeGreaterThan(CHUNK_TOKEN_LIMIT);

      const chunks = await (chunker as any).chunkText(text);

      for (const chunk of chunks) {
        const actualTokens = await (chunker as any).countTokens(chunk.text);
        expect(actualTokens).toBeLessThanOrEqual(CHUNK_TOKEN_LIMIT);
      }
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    it('handles single word at 10x chunkTokenLimit', async () => {
      const text = 'z'.repeat(CHUNK_TOKEN_LIMIT * 40); // ~10x tokens
      const chunks = await (chunker as any).chunkText(text);

      for (const chunk of chunks) {
        const actualTokens = await (chunker as any).countTokens(chunk.text);
        expect(actualTokens).toBeLessThanOrEqual(CHUNK_TOKEN_LIMIT);
      }
      expect(chunks.length).toBeGreaterThanOrEqual(10);
    });

    it('returns empty array for empty string', async () => {
      const chunks = await (chunker as any).chunkText('');
      expect(chunks).toEqual([]);
    });

    it('returns empty array for whitespace-only string', async () => {
      const chunks = await (chunker as any).chunkText('   \n\t  ');
      expect(chunks).toEqual([]);
    });

    it('handles normal English prose within limits', async () => {
      const text =
        'The quick brown fox jumps over the lazy dog. ' +
        'Pack my box with five dozen liquor jugs. ' +
        'How vexingly quick daft zebras jump.';
      const chunks = await (chunker as any).chunkText(text);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunks) {
        const actualTokens = await (chunker as any).countTokens(chunk.text);
        expect(actualTokens).toBeLessThanOrEqual(CHUNK_TOKEN_LIMIT);
      }
    });
  });

  describe('tokenCount accuracy', () => {
    it('every output chunk tokenCount matches re-counted actual tokens', async () => {
      const text = 'Hello world this is a test. '.repeat(200);
      const chunks = await (chunker as any).chunkText(text);

      for (const chunk of chunks) {
        const actualTokens = await (chunker as any).countTokens(chunk.text);
        expect(chunk.tokenCount).toBe(actualTokens);
      }
    });
  });

  describe('no empty chunks', () => {
    it('produces no empty chunks for mixed content', async () => {
      const text = 'word '.repeat(100) + 'a'.repeat(5000) + ' more words here';
      const chunks = await (chunker as any).chunkText(text);

      for (const chunk of chunks) {
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('text preservation', () => {
    it('concatenation of all chunk texts preserves original content (minus data URLs)', async () => {
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
      const chunks = await (chunker as any).chunkText(text);

      // The chunker adds spaces between sentences and trims, so we compare
      // the joined content stripped of extra whitespace
      const reconstructed = chunks.map((c: Chunk) => c.text).join(' ');
      const normalizeWs = (s: string) => s.replace(/\s+/g, ' ').trim();
      expect(normalizeWs(reconstructed)).toBe(normalizeWs(text));
    });
  });

  describe('mergeOrDropNearEmptyChunks (#2817)', () => {
    it('merges a near-empty chunk forward into the following chunk', async () => {
      const chunks: Chunk[] = [
        { text: 'This is a normal, reasonably long first chunk of real content here.', tokenCount: 15 },
        { text: 'x', tokenCount: 1 },
        { text: 'This is a normal, reasonably long third chunk of real content too.', tokenCount: 15 },
      ];
      const result = await (chunker as any).mergeOrDropNearEmptyChunks(chunks);

      expect(result).toHaveLength(2);
      expect(result[0].text).toBe(chunks[0].text);
      expect(result[1].text).toBe(`x ${chunks[2].text}`);
      for (const chunk of result) {
        expect(countCodePoints(chunk.text)).toBeGreaterThanOrEqual(MIN_CHUNK_CHARS_FLOOR);
      }
    });

    it('accumulates a run of several under-floor chunks until the floor clears', async () => {
      const chunks: Chunk[] = [
        { text: 'a', tokenCount: 1 },
        { text: 'b', tokenCount: 1 },
        { text: 'c', tokenCount: 1 },
        { text: 'd'.repeat(60), tokenCount: 20 },
      ];
      const result = await (chunker as any).mergeOrDropNearEmptyChunks(chunks);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe(`a b c ${'d'.repeat(60)}`);
    });

    it('drops a near-empty chunk when neither neighbor can absorb it without exceeding the token limit', async () => {
      const tinyChunker = createChunker(1);
      try {
        const chunks: Chunk[] = [
          { text: 'This is a long enough chunk of real content, over the floor mark.', tokenCount: 15 },
          { text: '.', tokenCount: 1 },
          { text: 'Another long enough chunk of real content, also over the floor mark.', tokenCount: 15 },
        ];
        const result = await (tinyChunker as any).mergeOrDropNearEmptyChunks(chunks);

        expect(result).toHaveLength(2);
        expect(result.some((c: Chunk) => c.text === '.')).toBe(false);
      } finally {
        tinyChunker.freeEncoder();
      }
    });

    it('keeps a lone near-empty chunk rather than leaving the file with zero chunks', async () => {
      const chunks: Chunk[] = [{ text: '.', tokenCount: 1 }];
      const result = await (chunker as any).mergeOrDropNearEmptyChunks(chunks);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('.');
    });

    it('merges a near-empty chunk BACKWARD into the preceding chunk when forward merge would overflow', async () => {
      // The next chunk is already far over the limit alone (as a real splitOversizedSegment
      // remainder always sits exactly at chunkTokenLimit), so a forward merge always overflows;
      // the preceding chunk has headroom and should absorb it instead of it being dropped.
      const limitedChunker = createChunker(50);
      try {
        const chunks: Chunk[] = [
          { text: 'This chunk has real content and plenty of headroom left.', tokenCount: 12 },
          { text: '.', tokenCount: 1 },
          { text: 'x'.repeat(5000), tokenCount: 9999 },
        ];
        const result = await (limitedChunker as any).mergeOrDropNearEmptyChunks(chunks);

        expect(result).toHaveLength(2);
        expect(result[0].text).toBe(`${chunks[0].text} .`);
        expect(result[1].text).toBe(chunks[2].text);
      } finally {
        limitedChunker.freeEncoder();
      }
    });

    it('merges a trailing near-empty chunk backward rather than dropping it', async () => {
      const chunks: Chunk[] = [
        { text: 'This is a normal, reasonably long final chunk of real content here.', tokenCount: 15 },
        { text: '.', tokenCount: 1 },
      ];
      const result = await (chunker as any).mergeOrDropNearEmptyChunks(chunks);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe(`${chunks[0].text} .`);
    });

    it('cascades: after a drop, the chunk that failed to absorb it gets its own chance as the new pendingShort', async () => {
      // With chunkTokenLimit=1, even "a z" (two single-char words) exceeds the limit, so the
      // forward merge of 'a' into 'z' fails; there is no preceding chunk yet (merged is empty),
      // so 'a' drops. 'z' itself is still under the floor, so - rather than being pushed straight
      // to merged - it becomes the NEW pendingShort and, being the last chunk, is kept as the
      // sole survivor (never leaving the file with zero chunks).
      const tinyChunker = createChunker(1);
      try {
        const chunks: Chunk[] = [
          { text: 'a', tokenCount: 1 },
          { text: 'z', tokenCount: 1 },
        ];
        const result = await (tinyChunker as any).mergeOrDropNearEmptyChunks(chunks);

        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('z');
      } finally {
        tinyChunker.freeEncoder();
      }
    });
  });

  describe('validateAndResplitChunks', () => {
    it('re-splits artificially oversized chunks', { timeout: 30000 }, async () => {
      const oversizedChunk: Chunk = {
        text: 'a'.repeat(10000),
        tokenCount: 99999, // Intentionally wrong
      };
      const result = await (chunker as any).validateAndResplitChunks([oversizedChunk]);

      for (const chunk of result) {
        const actualTokens = await (chunker as any).countTokens(chunk.text);
        expect(actualTokens).toBeLessThanOrEqual(CHUNK_TOKEN_LIMIT);
      }
      expect(result.length).toBeGreaterThan(1);
    });

    it('also merges/drops near-empty chunks (#2817) - proves the wiring, not just the isolated helper', async () => {
      // The mergeOrDropNearEmptyChunks tests above call that private method directly and would
      // stay green even if its call site inside validateAndResplitChunks were deleted. This test
      // goes through validateAndResplitChunks itself, so removing that call site fails it.
      const longChunk: Chunk = {
        text: 'This is a normal, reasonably long chunk of real content that clears the floor easily.',
        tokenCount: 20,
      };
      const shortChunk: Chunk = { text: '.', tokenCount: 1 };
      const result = await (chunker as any).validateAndResplitChunks([longChunk, shortChunk]);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe(`${longChunk.text} .`);
    });
  });

  describe('chunkFile with text/plain', () => {
    it('produces valid chunks for text/plain content with no whitespace', async () => {
      const content = Buffer.from('x'.repeat(20000));
      const chunks = await chunker.chunkFile(content, 'text/plain');

      for (const chunk of chunks) {
        const actualTokens = await (chunker as any).countTokens(chunk.text);
        expect(actualTokens).toBeLessThanOrEqual(CHUNK_TOKEN_LIMIT);
      }
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe('chunkFile with audio', () => {
    it('returns no chunks for audio (never vectorized)', async () => {
      const content = Buffer.from('fake-audio-bytes');
      expect(await chunker.chunkFile(content, 'audio/mpeg')).toEqual([]);
      expect(await chunker.chunkFile(content, 'audio/wav')).toEqual([]);
    });
  });

  describe('passage granularity (#1420)', () => {
    it('pins the default passage target and floor (a silent bump back toward whole-document chunks must fail CI)', () => {
      // Every other test in this block derives its bound FROM the constant, so mutating the
      // constant to e.g. 6000 would leave them all green. This assertion is the regression
      // tripwire for #1420 itself.
      expect(DEFAULT_PASSAGE_TOKEN_TARGET).toBe(512);
      expect(MIN_PASSAGE_TOKEN_TARGET).toBe(64);
    });

    // ~22KB of heterogeneous prose - the regression shape from the issue: a whole markdown
    // profile that previously became ONE chunk covering 100% of the document.
    const longDocument = Array.from(
      { length: 400 },
      (_, i) => `Section ${i} covers a distinct topic with its own facts and figures about subject ${i}.`
    ).join(' ');

    it('a default chunker splits a long document into passage-sized chunks, not one whole-document chunk', async () => {
      const defaultChunker = new SmartChunker(MODEL, mockStorage, new Logger({ component: 'chunk-test' }));
      try {
        const chunks = await defaultChunker.chunkFile(Buffer.from(longDocument), 'text/markdown');

        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
          expect(chunk.tokenCount).toBeLessThanOrEqual(DEFAULT_PASSAGE_TOKEN_TARGET);
        }
      } finally {
        defaultChunker.freeEncoder();
      }
    });

    it('honors an explicit passage target via the options object', async () => {
      const custom = new SmartChunker(MODEL, mockStorage, new Logger({ component: 'chunk-test' }), {
        passageTokenTarget: 128,
      });
      try {
        const chunks = await (custom as any).chunkText(longDocument);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
          expect(chunk.tokenCount).toBeLessThanOrEqual(128);
        }
      } finally {
        custom.freeEncoder();
      }
    });

    it('clamps a too-small passage target up to the minimum', () => {
      const tiny = new SmartChunker(MODEL, mockStorage, new Logger({ component: 'chunk-test' }), {
        passageTokenTarget: 10,
      });
      expect((tiny as any).chunkTokenLimit).toBe(MIN_PASSAGE_TOKEN_TARGET);
    });

    it('caps an oversized passage target at the buffered model limit', () => {
      const huge = new SmartChunker(MODEL, mockStorage, new Logger({ component: 'chunk-test' }), {
        passageTokenTarget: 999999,
      });
      // 8192 - max(floor(8192 * 0.2), 32) = 8192 - 1638
      expect((huge as any).chunkTokenLimit).toBe(8192 - 1638);
    });

    it('keeps legacy numeric buffer argument behavior (still wins when tighter than the passage target)', () => {
      // createChunker passes buffer = 8192 - 300 as a bare number: limit 300 < default 512.
      expect((chunker as any).chunkTokenLimit).toBe(CHUNK_TOKEN_LIMIT);
    });
  });

  describe('chunkFile with PPTX', () => {
    const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

    async function buildPptx(slides: string[]): Promise<Buffer> {
      const zip = new JSZip();
      slides.forEach((body, i) => {
        zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0"?><p:sld xmlns:a="x">${body}</p:sld>`);
      });
      return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    }

    it('strips run markup nested inside a run body rather than emitting it as text', async () => {
      // The regex this replaced stripped every `<a:t...>` in its match; slicing to the
      // first `</a:t>` keeps the ones inside the body, and the literal markup then lands
      // in the chunk text and in the embedding built from it.
      const pptx = await buildPptx(['<a:t>Quarterly <a:t xml:space="preserve">revenue</a:t>', '<a:t>Summary</a:t>']);
      const chunks = await chunker.chunkFile(pptx, PPTX_MIME);
      const allText = chunks.map(c => c.text).join(' ');
      expect(allText).toContain('Quarterly revenue');
      expect(allText).not.toContain('<a:t');
    });

    it('extracts text from <a:t> runs that carry attributes (e.g. xml:space)', async () => {
      // Regression: the matcher previously only matched bare <a:t>, silently dropping
      // attributed runs - which are common in real PPTX files - yielding 0 chunks.
      const pptx = await buildPptx(['<a:t xml:space="preserve">Attributed run text</a:t>', '<a:t>Bare run text</a:t>']);
      const chunks = await chunker.chunkFile(pptx, PPTX_MIME);
      const allText = chunks.map(c => c.text).join(' ');
      expect(chunks.length).toBeGreaterThan(0);
      expect(allText).toContain('Attributed run text');
      expect(allText).toContain('Bare run text');
    });

    it('stays linear on a slide that opens runs it never closes', async () => {
      // The previous matcher restarted a lazy `[\s\S]*?` scan at every `<a:t`, so XML full of
      // unterminated runs cost O(n^2) - and a .pptx is a zip, so the uploader picks n up to the
      // per-slide byte cap. 2MB of opens finished in minutes before; the indexOf scan is linear.
      // `<a:tbl>` shares the prefix and must not be mistaken for a run.
      const unterminated = '<a:tbl/><a:t>'.repeat(160_000);
      const pptx = await buildPptx([unterminated, '<a:t>Normal slide text</a:t>']);
      const start = Date.now();
      const chunks = await chunker.chunkFile(pptx, PPTX_MIME);
      const allText = chunks.map(c => c.text).join(' ');
      expect(allText).toContain('Normal slide text');
      expect(Date.now() - start).toBeLessThan(5000);
    }, 30_000);

    it('extracts every run on a slide with many well-formed runs', async () => {
      // The case above exits on its FIRST `<a:t`: nothing closes anywhere, so indexOf
      // returns -1 and the scan breaks immediately. That proves it cannot hang, but the
      // loop never iterates, so it says nothing about extraction. This one drives the
      // scan through 20k runs and checks what came out.
      const runs = Array.from({ length: 20_000 }, (_, i) => `<a:t>run ${i}</a:t>`).join('<a:tab/>');
      const pptx = await buildPptx([runs]);
      const start = Date.now();
      const chunks = await chunker.chunkFile(pptx, PPTX_MIME);
      const allText = chunks.map(c => c.text).join(' ');
      expect(allText).toContain('run 0');
      expect(allText).toContain('run 19999');
      expect(allText).not.toContain('<a:t>');
      expect(Date.now() - start).toBeLessThan(5000);
    }, 30_000);

    it('skips a slide whose decompressed XML exceeds the per-entry cap, keeping the rest', async () => {
      // A .pptx is a zip; one slide entry can inflate ~1000x when decompressed (zip-bomb shape).
      // The oversized slide is skipped before it is materialized; the normal slide still chunks.
      const huge = `<a:t>OVERSIZED_MARKER ${'x'.repeat(17 * 1024 * 1024)}</a:t>`;
      const pptx = await buildPptx([huge, '<a:t>Normal slide text</a:t>']);
      const start = Date.now();
      const chunks = await chunker.chunkFile(pptx, PPTX_MIME);
      const allText = chunks.map(c => c.text).join(' ');
      expect(allText).toContain('Normal slide text');
      expect(allText).not.toContain('OVERSIZED_MARKER');
      expect(Date.now() - start).toBeLessThan(5000);
    });

    it('stops chunking once the slides exhaust the aggregate XML budget', async () => {
      // The per-slide and slide-count caps bound each item, but an attacker controls their
      // product: 5,000 slides at 16MB each is ~80GB of decompression driven by one upload. Bulk
      // that carries no text is the cheap shape, so each slide here is 15MB of XML comment with
      // one short run. The 32MB budget admits two, then the walk stops.
      const bulk = (n: number) => `<!--${'x'.repeat(15 * 1024 * 1024)}--><a:t>SLIDE_${n}</a:t>`;
      const pptx = await buildPptx([bulk(1), bulk(2), bulk(3), '<a:t>TAIL_SLIDE</a:t>']);
      const chunks = await chunker.chunkFile(pptx, PPTX_MIME);
      const allText = chunks.map(c => c.text).join(' ');

      expect(allText).toContain('SLIDE_1');
      expect(allText).toContain('SLIDE_2');
      expect(allText).not.toContain('SLIDE_3');
      expect(allText).not.toContain('TAIL_SLIDE');
    }, 60_000);

    it('caps the extracted text handed to chunkText, which the XML budget does not imply', async () => {
      // 32MB of slide XML can still yield tens of MB of text, and tiktoken traps rather than
      // returning on a string that size - so the accumulated text needs its own bound. The
      // oversized slide is truncated at the cap and the walk stops.
      const wordy = `<a:t>HEAD_MARKER ${'word '.repeat(600_000)} TAIL_MARKER</a:t>`;
      const pptx = await buildPptx([wordy, '<a:t>NEXT_SLIDE</a:t>']);
      const chunks = await chunker.chunkFile(pptx, PPTX_MIME);
      const allText = chunks.map(c => c.text).join(' ');

      expect(allText).toContain('HEAD_MARKER');
      expect(allText).not.toContain('TAIL_MARKER'); // truncated at the cap
      expect(allText).not.toContain('NEXT_SLIDE'); // walk stopped
    }, 60_000);
  });
});

describe('getExtractedText (lake admission fingerprint source, #1679)', () => {
  const buildChunker = (passageTokenTarget: number): SmartChunker =>
    new SmartChunker(MODEL, mockStorage, new Logger({ component: 'chunk-test' }), { passageTokenTarget });

  it('is identical across chunk sizes even when the chunk OUTPUT is not - the fingerprint is policy-independent', async () => {
    // A long whitespace-free token routes through splitOversizedSegment (mid-token splits): it is
    // fragmented into many chunks at a small target and stays whole at a large one, so the chunk
    // TEXT differs by policy. The extracted text - what the admission hash fingerprints - must not.
    const text = 'x'.repeat(4000);
    const buf = Buffer.from(text, 'utf8');

    const small = buildChunker(MIN_PASSAGE_TOKEN_TARGET); // 64
    const chunksSmall = await small.chunkFile(buf, 'text/plain');
    small.freeEncoder();

    const large = buildChunker(6000);
    const chunksLarge = await large.chunkFile(buf, 'text/plain');
    large.freeEncoder();

    // Output genuinely diverges with policy...
    expect(chunksSmall.length).toBeGreaterThan(chunksLarge.length);
    expect(chunksSmall.map(c => c.text)).not.toEqual(chunksLarge.map(c => c.text));
    // ...but the extracted text (and therefore the fingerprint) is stable and equals the source.
    expect(small.getExtractedText()).toBe(text);
    expect(small.getExtractedText()).toBe(large.getExtractedText());
  });

  it('is undefined for a file that yields no extractable text', async () => {
    const chunker = buildChunker(DEFAULT_PASSAGE_TOKEN_TARGET);
    await chunker.chunkFile(Buffer.from('anything'), 'application/octet-stream');
    chunker.freeEncoder();
    expect(chunker.getExtractedText()).toBeUndefined();
  });
});

// The parsers have their own unit tests; this covers the wiring - that chunkFile actually reaches
// them for the formats that carry a vintage, and leaves the slot empty for the ones that do not.
describe('chunkFile captures a document date', () => {
  const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

  async function buildDatedPptx(
    coreXmlBody: string | null,
    compression: 'STORE' | 'DEFLATE' = 'STORE'
  ): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld xmlns:a="x"><a:t>Slide text</a:t></p:sld>');
    if (coreXmlBody !== null) {
      zip.file(
        'docProps/core.xml',
        // Padded so DEFLATE actually emits a compressed stream there is something to damage; a
        // few hundred bytes is also the realistic size of a real core.xml.
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties>${coreXmlBody}` +
          `<cp:keywords>${'quarterly revenue '.repeat(40)}</cp:keywords></cp:coreProperties>`
      );
    }
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression }));
  }

  /**
   * Damage one entry's compressed payload in place, leaving every zip header intact, so the file
   * opens and lists normally and only fails when that entry is actually inflated. Corrupting the
   * headers instead would fail the container load and prove nothing about the guard under test.
   */
  function corruptZipEntryPayload(zipBuffer: Buffer, entryName: string): Buffer {
    const damaged = Buffer.from(zipBuffer);
    const name = Buffer.from(entryName, 'utf8');
    for (let i = 0; i + 30 <= damaged.length; i++) {
      if (damaged.readUInt32LE(i) !== 0x04034b50) continue;
      const nameLength = damaged.readUInt16LE(i + 26);
      const extraLength = damaged.readUInt16LE(i + 28);
      if (nameLength !== name.length || !damaged.subarray(i + 30, i + 30 + nameLength).equals(name)) continue;
      // Past the first deflate block's header, so the inflater starts fine and then hits garbage.
      const payloadStart = i + 30 + nameLength + extraLength + 6;
      damaged.fill(0, payloadStart, payloadStart + 16);
      return damaged;
    }
    throw new Error(`fixture error: no local file header for ${entryName}`);
  }

  let chunker: SmartChunker;
  beforeEach(() => {
    chunker = createChunker();
  });
  afterEach(() => {
    chunker.freeEncoder();
    jsZipLoadFailure.message = null;
  });

  // Every mime in the allowlist, because they reach the scan through the same default branch and a
  // missing member is silent: the file chunks normally and simply never gets a vintage. That is
  // how `text/x-markdown` - a persisted mime the claim-first resolver hands Drive ingest - was
  // left out.
  it.each(['text/markdown', 'text/x-markdown', 'text/plain'])('reads frontmatter from %s', async mimeType => {
    await chunker.chunkFile(Buffer.from('---\ntitle: Report\ndate: 2019-03-04\n---\n\nBody text.'), mimeType);
    expect(chunker.getDocumentDate()).toEqual({
      date: new Date('2019-03-04T00:00:00.000Z'),
      source: DocumentDateSource.FRONTMATTER,
    });
  });

  // The gate exists because `---` leads a horizontal rule, a diff hunk and a YAML stream too; only
  // the formats where a leading block conventionally IS document frontmatter are scanned.
  it('does not scan a text type outside the frontmatter allowlist', async () => {
    await chunker.chunkFile(Buffer.from('---\ndate: 2019-03-04\n---\n\n<p>Body</p>'), 'text/html');
    expect(chunker.getDocumentDate()).toBeUndefined();
  });

  /**
   * A structurally minimal but real .docx: mammoth resolves the document part through
   * `_rels/.rels`, so the relationship and content-type parts have to be present even though only
   * `word/document.xml` and `docProps/core.xml` carry anything this test reads.
   */
  async function buildDatedDocx(
    coreXmlBody: string | null,
    compression: 'STORE' | 'DEFLATE' = 'STORE'
  ): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>'
    );
    zip.file(
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>'
    );
    zip.file(
      'word/document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:r><w:t>Quarterly revenue report</w:t></w:r></w:p></w:body></w:document>'
    );
    if (coreXmlBody !== null) {
      zip.file(
        'docProps/core.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties>${coreXmlBody}</cp:coreProperties>`
      );
    }
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression }));
  }

  // DOCX reaches readOoxmlDocumentDate through its own container open (mammoth exposes no metadata
  // API), so the PPTX suite below proves nothing about it: deleting the DOCX wiring failed no test.
  describe('DOCX, which opens its own container for the property', () => {
    const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    it('reads dcterms:created and still extracts the document text', async () => {
      const docx = await buildDatedDocx(
        '<dcterms:created xsi:type="dcterms:W3CDTF">2019-03-04T09:15:00Z</dcterms:created>'
      );
      const chunks = await chunker.chunkFile(docx, DOCX_MIME);
      expect(chunks.map(c => c.text).join(' ')).toContain('Quarterly revenue report');
      expect(chunker.getDocumentDate()).toEqual({
        date: new Date('2019-03-04T09:15:00.000Z'),
        source: DocumentDateSource.DOCUMENT_PROPERTIES,
      });
    });

    it('leaves the slot empty for a DOCX with no core properties', async () => {
      const chunks = await chunker.chunkFile(await buildDatedDocx(null), DOCX_MIME);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunker.getDocumentDate()).toBeUndefined();
    });

    // Regression: mammoth extracts the text through its OWN zip read, entirely separate from the
    // one opened here just for the date - so a second opener choking on the same bytes must cost
    // the file only its vintage, not the chunks mammoth already produced.
    it('still extracts text when the container cannot be reopened for its date', async () => {
      const docx = await buildDatedDocx(
        '<dcterms:created xsi:type="dcterms:W3CDTF">2019-03-04T09:15:00Z</dcterms:created>'
      );
      jsZipLoadFailure.message = 'zip end of central directory not found';
      const chunks = await chunker.chunkFile(docx, DOCX_MIME);
      expect(chunks.map(c => c.text).join(' ')).toContain('Quarterly revenue report');
      expect(chunker.getDocumentDate()).toBeUndefined();
    });

    // Mirrors the PPTX case below: openOoxmlContainerForDate opens fine (the zip headers are
    // intact), but readOoxmlDocumentDate's own readZipEntryBounded call fails to inflate the
    // damaged entry. Text extraction goes through mammoth's own, separate zip read, so it must
    // survive even though the date read does not.
    it('leaves the slot empty for a DOCX whose core.xml cannot be decompressed', async () => {
      const docx = corruptZipEntryPayload(
        await buildDatedDocx(
          '<dcterms:created>2019-03-04T09:15:00Z</dcterms:created>' +
            `<cp:keywords>${'quarterly revenue '.repeat(40)}</cp:keywords>`,
          'DEFLATE'
        ),
        'docProps/core.xml'
      );
      const chunks = await chunker.chunkFile(docx, DOCX_MIME);
      expect(chunks.map(c => c.text).join(' ')).toContain('Quarterly revenue report');
      expect(chunker.getDocumentDate()).toBeUndefined();
    });
  });

  it('reads dcterms:created out of an OOXML container', async () => {
    const pptx = await buildDatedPptx(
      '<dcterms:created xsi:type="dcterms:W3CDTF">2019-03-04T09:15:00Z</dcterms:created>'
    );
    await chunker.chunkFile(pptx, PPTX_MIME);
    expect(chunker.getDocumentDate()).toEqual({
      date: new Date('2019-03-04T09:15:00.000Z'),
      source: DocumentDateSource.DOCUMENT_PROPERTIES,
    });
  });

  it('leaves the slot empty for an OOXML container with no core properties', async () => {
    await chunker.chunkFile(await buildDatedPptx(null), PPTX_MIME);
    expect(chunker.getDocumentDate()).toBeUndefined();
  });

  // Proves the plausibility funnel is on the chunker path, not only in the parser's own tests:
  // 1601-01-01 is Windows FILETIME zero, which parses as a perfectly valid calendar date.
  it('refuses an implausible container date rather than storing it', async () => {
    const pptx = await buildDatedPptx('<dcterms:created>1601-01-01T00:00:00Z</dcterms:created>');
    await chunker.chunkFile(pptx, PPTX_MIME);
    expect(chunker.getDocumentDate()).toBeUndefined();
  });

  // The cap is the compression-bomb guard: a real core.xml is a few hundred bytes, so anything
  // claiming more is not metadata. STORE keeps the fixture's declared size honest - a DEFLATEd
  // megabyte of repeated padding would be a few hundred bytes on disk and prove nothing.
  it('skips a core.xml over the size cap, keeping the document chunked', async () => {
    const oversized = await buildDatedPptx(
      `<dcterms:created>2019-03-04T09:15:00Z</dcterms:created><cp:keywords>${'x'.repeat(300 * 1024)}</cp:keywords>`
    );
    const chunks = await chunker.chunkFile(oversized, PPTX_MIME);
    expect(chunks.map(c => c.text).join(' ')).toContain('Slide text');
    expect(chunker.getDocumentDate()).toBeUndefined();
  });

  // Regression: the OOXML read is a best-effort side read of an AUXILIARY part, so a core.xml the
  // inflater cannot decompress must cost the file its vintage and NOTHING else. Before the guard in
  // readOoxmlDocumentDate, readZipEntryBounded's rejection propagated out of chunkFile and the
  // document produced zero chunks - unsearchable because of a few bad bytes in a metadata entry.
  it('still chunks an OOXML container whose core.xml cannot be decompressed', async () => {
    const pptx = corruptZipEntryPayload(
      await buildDatedPptx('<dcterms:created>2019-03-04T09:15:00Z</dcterms:created>', 'DEFLATE'),
      'docProps/core.xml'
    );
    const chunks = await chunker.chunkFile(pptx, PPTX_MIME);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map(c => c.text).join(' ')).toContain('Slide text');
    expect(chunker.getDocumentDate()).toBeUndefined();
  });

  // Regression: SheetJS declares `Props.CreatedDate` as a Date, but its BIFF8 (.xls) reader returns
  // an ISO STRING - so the funnel's getTime() threw a TypeError and chunkFile rejected, costing the
  // file every chunk. Typecheck stays green on this, which is why it needs a test on the real
  // reader rather than a hand-shaped fixture.
  describe('spreadsheets, whose two container formats keep the authored date in different places', () => {
    const XLS_MIME = 'application/vnd.ms-excel';
    const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    async function buildDatedWorkbook(bookType: 'biff8' | 'xlsx', createdDate: Date): Promise<Buffer> {
      const { utils, write } = await import('xlsx');
      const workbook = utils.book_new();
      utils.book_append_sheet(
        workbook,
        utils.aoa_to_sheet([
          ['Region', 'Revenue'],
          ['North', 42],
        ]),
        'Sheet1'
      );
      // Set on the WORKBOOK, not passed as a write option: the BIFF8 writer ignores opts.Props and
      // emits no summary stream at all, which makes every assertion below pass vacuously.
      workbook.Props = { CreatedDate: createdDate };
      return Buffer.from(write(workbook, { type: 'buffer', bookType }) as ArrayBuffer);
    }

    // Guards the fixture itself: if a SheetJS upgrade ever makes the legacy reader return a real
    // Date, this fails and the string branch above is no longer being exercised by these tests.
    it('fixture check: the legacy reader really does hand back a string', async () => {
      const { read } = await import('xlsx');
      const xls = await buildDatedWorkbook('biff8', new Date('2019-03-04T00:00:00Z'));
      expect(typeof read(xls, { type: 'buffer' }).Props?.CreatedDate).toBe('string');
    });

    it('captures the created date and still produces chunks', async () => {
      const xls = await buildDatedWorkbook('biff8', new Date('2019-03-04T00:00:00Z'));
      const chunks = await chunker.chunkFile(xls, XLS_MIME);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunker.getDocumentDate()).toEqual({
        date: new Date('2019-03-04T00:00:00.000Z'),
        source: DocumentDateSource.DOCUMENT_PROPERTIES,
      });
    });

    // .xlsx no longer takes this date through SheetJS's Props reader at all - it goes through
    // docProps/core.xml like docx and pptx (see readWorkbookDocumentDate) - so this pins that the
    // SAME workbook still yields the same date via that other path, against the real writer rather
    // than a hand-shaped fixture. The offset-bearing and dc:date-fallback cases below cover the
    // core.xml path itself in detail.
    it('captures the same date from the real writer, via the OOXML core.xml path', async () => {
      const xlsx = await buildDatedWorkbook('xlsx', new Date('2019-03-04T00:00:00Z'));
      const chunks = await chunker.chunkFile(xlsx, XLSX_MIME);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunker.getDocumentDate()).toEqual({
        date: new Date('2019-03-04T00:00:00.000Z'),
        source: DocumentDateSource.DOCUMENT_PROPERTIES,
      });
    });

    it('refuses an implausible created date from the legacy reader too', async () => {
      const xls = await buildDatedWorkbook('biff8', new Date('1601-01-01T00:00:00Z'));
      const chunks = await chunker.chunkFile(xls, XLS_MIME);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunker.getDocumentDate()).toBeUndefined();
    });

    // Regression: readWorkbookDocumentDate now tries JSZip.loadAsync unconditionally, not just when
    // isZipContainer's byte sniff already said yes - so a container that opener chokes on entirely
    // must fall back to the SheetJS-parsed date already in hand, not lose the vintage outright.
    it('falls back to the SheetJS date when the workbook container cannot be opened at all', async () => {
      const xlsx = await buildDatedWorkbook('xlsx', new Date('2019-03-04T00:00:00Z'));
      jsZipLoadFailure.message = 'zip end of central directory not found';
      const chunks = await chunker.chunkFile(xlsx, XLSX_MIME);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunker.getDocumentDate()).toEqual({
        date: new Date('2019-03-04T00:00:00.000Z'),
        source: DocumentDateSource.DOCUMENT_PROPERTIES,
      });
    });

    /**
     * Rewrite a real workbook's `docProps/core.xml`, leaving every other entry untouched, so the
     * container stays a workbook SheetJS can parse while the property under test is controlled.
     * Building the core.xml by hand is the only way to reach these cases: every writer in the wild
     * - SheetJS's included - emits `Z`, which is exactly why the offset bug stayed invisible.
     */
    async function xlsxWithCoreXml(coreXmlBody: string): Promise<Buffer> {
      const zip = await JSZip.loadAsync(await buildDatedWorkbook('xlsx', new Date('2001-01-01T00:00:00Z')));
      zip.file(
        'docProps/core.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<cp:coreProperties xmlns:cp="x" xmlns:dc="x" xmlns:dcterms="x">${coreXmlBody}</cp:coreProperties>`
      );
      return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    }

    // The regression this whole split exists for: SheetJS builds Props.CreatedDate with
    // `new Date(...)`, a true UTC instant, so this rendered 2019-03-03 while the byte-identical
    // core.xml inside a .docx rendered 2019-03-04. One authored day must render the same whatever
    // container carried it - see the cross-format test in documentDate.test.ts.
    it('renders the authored day for an offset-bearing core.xml, not the UTC one', async () => {
      const xlsx = await xlsxWithCoreXml('<dcterms:created>2019-03-04T00:00:00+08:00</dcterms:created>');
      const chunks = await chunker.chunkFile(xlsx, XLSX_MIME);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunker.getDocumentDate()?.date.toISOString().slice(0, 10)).toBe('2019-03-04');
    });

    // The other thing reading core.xml directly buys: SheetJS's property reader has no dc:date
    // fallback, so a producer that writes only that one was previously undated.
    it('reads a core.xml carrying only dc:date', async () => {
      const xlsx = await xlsxWithCoreXml('<dc:date>2019-03-04T09:30:00Z</dc:date>');
      const chunks = await chunker.chunkFile(xlsx, XLSX_MIME);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunker.getDocumentDate()).toEqual({
        date: new Date('2019-03-04T09:30:00.000Z'),
        source: DocumentDateSource.DOCUMENT_PROPERTIES,
      });
    });

    // A .xlsx whose core.xml offers nothing is undated, rather than falling back to the SheetJS
    // Props path this split exists to keep it off.
    it('leaves a .xlsx undated when its core.xml carries no date', async () => {
      const xlsx = await xlsxWithCoreXml('<dc:title>Quarterly review</dc:title>');
      const chunks = await chunker.chunkFile(xlsx, XLSX_MIME);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunker.getDocumentDate()).toBeUndefined();
    });

    // The comment on readWorkbookDocumentDate explains why this is tried unconditionally rather
    // than gated on isZipContainer's position-0 sniff: JSZip locates the central directory by
    // scanning from the END of the buffer, so bytes prepended ahead of the PK signature - a stray
    // BOM, a mangled preamble some upload path left behind - do not stop it finding core.xml, even
    // though those same leading bytes fail isZipContainer's own byte sniff.
    it('reads docProps/core.xml when junk bytes are prepended before the zip signature', async () => {
      const xlsx = await xlsxWithCoreXml('<dcterms:created>2019-03-04T09:15:00Z</dcterms:created>');
      const withPrependedBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), xlsx]);
      const chunks = await chunker.chunkFile(withPrependedBytes, XLSX_MIME);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunker.getDocumentDate()).toEqual({
        date: new Date('2019-03-04T09:15:00.000Z'),
        source: DocumentDateSource.DOCUMENT_PROPERTIES,
      });
    });

    // Distinct from the "no date" case above: here the entry itself is absent, not merely
    // empty, so readOoxmlDocumentDate's `zip.files[...]` lookup - not its parse of the XML -
    // is what returns undefined.
    it('leaves a .xlsx undated when its zip has no docProps/core.xml entry at all', async () => {
      const zip = await JSZip.loadAsync(await buildDatedWorkbook('xlsx', new Date('2019-03-04T00:00:00Z')));
      zip.remove('docProps/core.xml');
      const xlsx = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));

      const chunks = await chunker.chunkFile(xlsx, XLSX_MIME);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunker.getDocumentDate()).toBeUndefined();
    });
  });

  // The PDF path is the only one whose extractor lives behind a third-party reader we do not pin
  // ourselves (unpdf vendors its own pdf.js). parsePdfInfoDate refuses a non-string outright, so a
  // reader upgrade that starts handing back a Date object would kill this path with no error
  // anywhere - the vintage would simply stop appearing. This drives the REAL reader to catch that.
  describe('PDF info dictionary, read through the real unpdf reader', () => {
    /** A minimal but structurally valid single-page PDF with `CreationDate` in its Info dict. */
    function buildPdf(creationDate: string | null): Buffer {
      const content = 'BT /F1 24 Tf 72 700 Td (Quarterly revenue report) Tj ET';
      const objects = [
        '<</Type/Catalog/Pages 2 0 R>>',
        '<</Type/Pages/Kids[3 0 R]/Count 1>>',
        '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
        `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
        '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
        creationDate === null ? '<</Producer(test)>>' : `<</CreationDate(${creationDate})>>`,
      ];

      let pdf = '%PDF-1.4\n';
      const offsets: number[] = [];
      objects.forEach((body, i) => {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
      });
      // A real xref table, not a broken one pdf.js would silently rebuild: the point of this
      // fixture is to exercise the reader's normal path, not its recovery path.
      const xrefStart = pdf.length;
      pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
      pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R/Info 6 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
      return Buffer.from(pdf, 'latin1');
    }

    it('reads CreationDate out of a real PDF and still extracts its text', async () => {
      const chunks = await chunker.chunkFile(buildPdf('D:20190304091500Z'), 'application/pdf');
      expect(chunks.map(c => c.text).join(' ')).toContain('Quarterly revenue report');
      expect(chunker.getDocumentDate()).toEqual({
        date: new Date('2019-03-04T09:15:00.000Z'),
        source: DocumentDateSource.PDF_METADATA,
      });
    });

    // Guards the fixture against a reader upgrade: parsePdfInfoDate takes `unknown` and refuses
    // anything that is not a string, so if this ever stops being a string the test above would
    // start passing vacuously rather than failing.
    it('fixture check: the reader hands back CreationDate as a string', async () => {
      const { getDocumentProxy } = await import('unpdf');
      const { info } = await getDocumentProxy(new Uint8Array(buildPdf('D:20190304091500Z'))).then(p => p.getMetadata());
      expect(typeof (info as unknown as Record<string, unknown>).CreationDate).toBe('string');
    });

    it('leaves the slot empty for a PDF whose Info dict carries no CreationDate', async () => {
      await chunker.chunkFile(buildPdf(null), 'application/pdf');
      expect(chunker.getDocumentDate()).toBeUndefined();
    });

    // The metadata read happens AFTER the text is already extracted, so a reader that raises there
    // must cost the file its vintage and nothing else. Driven through the mock because pdf.js
    // recovers from every malformed Info dict a fixture can express.
    it('still chunks a PDF whose metadata read raises', async () => {
      pdfMetadataFailure.message = 'simulated pdf.js metadata failure';
      try {
        const chunks = await chunker.chunkFile(buildPdf('D:20190304091500Z'), 'application/pdf');
        expect(chunks.map(c => c.text).join(' ')).toContain('Quarterly revenue report');
        expect(chunker.getDocumentDate()).toBeUndefined();
      } finally {
        pdfMetadataFailure.message = null;
      }
    });
  });

  // A chunker instance is reused across files in the ingest loop, so a stale date surviving into
  // the next file would stamp one document's vintage onto another's.
  it('resets between files', async () => {
    const pptx = await buildDatedPptx('<dcterms:created>2019-03-04T09:15:00Z</dcterms:created>');
    await chunker.chunkFile(pptx, PPTX_MIME);
    expect(chunker.getDocumentDate()).toBeDefined();

    await chunker.chunkFile(Buffer.from('Plain text with no vintage.'), 'text/plain');
    expect(chunker.getDocumentDate()).toBeUndefined();
  });
});
