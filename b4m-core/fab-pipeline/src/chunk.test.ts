import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  async function buildDatedPptx(coreXmlBody: string | null): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld xmlns:a="x"><a:t>Slide text</a:t></p:sld>');
    if (coreXmlBody !== null) {
      zip.file(
        'docProps/core.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties>${coreXmlBody}</cp:coreProperties>`
      );
    }
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }

  let chunker: SmartChunker;
  beforeEach(() => {
    chunker = createChunker();
  });
  afterEach(() => {
    chunker.freeEncoder();
  });

  it('reads frontmatter from a markdown file', async () => {
    await chunker.chunkFile(Buffer.from('---\ntitle: Report\ndate: 2019-03-04\n---\n\nBody text.'), 'text/markdown');
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
