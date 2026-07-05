import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import { SmartChunker, Chunk } from './chunk';
import { Logger } from '@bike4mind/observability';

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

describe('SmartChunker', () => {
  let chunker: SmartChunker;

  beforeEach(() => {
    chunker = createChunker();
  });

  afterEach(() => {
    chunker.freeEncoder();
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

  describe('chunkFile with PPTX', () => {
    const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

    async function buildPptx(slides: string[]): Promise<Buffer> {
      const zip = new JSZip();
      slides.forEach((body, i) => {
        zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0"?><p:sld xmlns:a="x">${body}</p:sld>`);
      });
      return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    }

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
  });
});
