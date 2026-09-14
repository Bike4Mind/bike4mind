import { describe, expect, it, vi, afterEach } from 'vitest';
import { OpenAIEmbeddingModel, OllamaEmbeddingModel, getEmbeddingModelCost } from '@bike4mind/common';
import {
  assertOnePerInput,
  chunkTokenCount,
  embedAll,
  findOversizedChunks,
  formatCapturePlan,
  isCapturableFile,
  modalLength,
  readAllPages,
  toBatches,
  parseSupportedModels,
  planCapture,
  selectReusableChunks,
  totalExcluded,
  type StoredChunk,
} from './capturePlan';
import { OPENAI_MAX_INPUTS_PER_REQUEST, OPENAI_MAX_TOKENS_PER_INPUT } from '@bike4mind/fab-pipeline';
import type { EmbeddingService } from '@bike4mind/fab-pipeline';

const SMALL = OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL;
const LARGE = OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE;
const ADA = OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002;

afterEach(() => vi.restoreAllMocks());

describe('planCapture', () => {
  it('prices from the shipped rate table, not from a literal in this harness', () => {
    const tokens = [1000, 2000, 3000];
    const plan = planCapture(tokens, [SMALL, LARGE]);
    // Pinned against the shipped function rather than a hardcoded dollar figure, so a provider
    // price change moves both together instead of leaving the preflight quoting a stale number.
    expect(plan.perModel[0].usd).toBe(getEmbeddingModelCost(SMALL, 6000));
    expect(plan.perModel[1].usd).toBe(getEmbeddingModelCost(LARGE, 6000));
    expect(plan.totalUsd).toBeCloseTo(plan.perModel[0].usd + plan.perModel[1].usd, 12);
  });

  it('counts chunks and batches at the provider input ceiling', () => {
    const plan = planCapture(new Array(5000).fill(10), [SMALL]);
    expect(plan.chunks).toBe(5000);
    expect(plan.perModel[0].tokens).toBe(50_000);
    expect(plan.perModel[0].batches).toBe(Math.ceil(5000 / OPENAI_MAX_INPUTS_PER_REQUEST));
  });

  it('splits on the TOKEN ceiling too, which is what a long-document corpus actually hits', () => {
    // 2048 chunks of ~550 tokens is over a million, well past the per-request token limit - so an
    // input-count-only estimate under-reports the requests by an order of magnitude.
    const plan = planCapture(new Array(2000).fill(2000), [SMALL]);
    expect(plan.perModel[0].batches).toBeGreaterThan(Math.ceil(2000 / OPENAI_MAX_INPUTS_PER_REQUEST));
  });

  it('plans no batch for no chunks', () => {
    expect(planCapture([], [SMALL]).perModel[0].batches).toBe(0);
  });

  it('reports 3-large as the more expensive arm, which is the whole cost argument', () => {
    const plan = planCapture([1_000_000], [SMALL, LARGE]);
    expect(plan.perModel[1].usd).toBeGreaterThan(plan.perModel[0].usd);
  });

  it('surfaces an unpriced model instead of quoting it as free', () => {
    // getEmbeddingModelCost settles an unknown model at $0 with an alarm. As a SPEND GATE that
    // reads as "this is free", which is the one lie a preflight must not tell.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const plan = planCapture([1000], ['some-unregistered-embedder']);
    expect(plan.perModel[0].unpriced).toBe(true);
    expect(plan.anyUnpriced).toBe(true);
    expect(formatCapturePlan(plan)).toContain('UNPRICED');
    expect(formatCapturePlan(plan)).toContain('TOTAL                : UNKNOWN');
  });

  it('treats a keyless local embedder as genuinely free, not as unpriced', () => {
    const plan = planCapture([1000], [OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B]);
    expect(plan.perModel[0].usd).toBe(0);
    expect(plan.perModel[0].unpriced).toBe(false);
    expect(plan.anyUnpriced).toBe(false);
  });

  it('does not call a zero-token plan of a priced model unpriced', () => {
    expect(planCapture([], [SMALL]).anyUnpriced).toBe(false);
  });

  it('renders a plan a human can approve from', () => {
    const text = formatCapturePlan(planCapture([1000, 1000], [SMALL, LARGE]));
    expect(text).toContain('chunks to embed      : 2');
    expect(text).toContain(SMALL);
    expect(text).toContain(LARGE);
    expect(text).toMatch(/TOTAL {16}: \$\d/);
  });

  it('does not quote a chunk-embed plan under --reuse-stored-vectors', () => {
    // No model in the plan means nothing is embedded but the probe queries. A chunk count would be
    // of chunks that will NOT be embedded, and a $0.0000 total would omit the queries that are.
    const text = formatCapturePlan(planCapture([1000, 1000], []));
    expect(text).toContain('reusing stored vectors');
    expect(text).not.toContain('chunks to embed');
    expect(text).not.toContain('$0.0000');
  });
});

describe('isCapturableFile', () => {
  const live = { chunkCount: 12, vectorizedChunkCount: 12, fileName: 'guide.pdf', vectorized: true };

  it('admits a live, fully vectorized file', () => {
    expect(isCapturableFile(live)).toBe(true);
  });

  it('excludes an ARCHIVED file, which findIdsByDataLakeTag returns and the served path never does', () => {
    expect(isCapturableFile({ ...live, archivedAt: new Date() })).toBe(false);
  });

  it('excludes a soft-deleted file', () => {
    expect(isCapturableFile({ ...live, deletedAt: new Date() })).toBe(false);
  });

  it('excludes a file whose vectorization stopped part way', () => {
    // Its chunks are not reliably in the vector index, so scoring them moves the band by chunks
    // production cannot surface.
    expect(isCapturableFile({ ...live, vectorizedChunkCount: 5 })).toBe(false);
    expect(isCapturableFile({ ...live, vectorizedChunkCount: undefined })).toBe(false);
  });

  it('excludes a file with no chunks at all', () => {
    expect(isCapturableFile({ ...live, chunkCount: 0, vectorizedChunkCount: 0 })).toBe(false);
    expect(isCapturableFile({ ...live, chunkCount: undefined })).toBe(false);
  });

  it('applies the shipped retrieval-exclusion filter when one is given', () => {
    expect(isCapturableFile({ ...live, fileName: 'MARK - draft.pdf' }, { excludeFilenameMarkers: ['mark'] })).toBe(
      false
    );
    expect(isCapturableFile({ ...live, fileName: 'MARKdown.pdf' }, { excludeFilenameMarkers: ['mark'] })).toBe(true);
  });

  it("ignores the embeddingModel stamp, which is one arm's business and not the file set's", () => {
    // Deliberately NOT isFabFileCitable's fifth condition: the arms vary the model on purpose, and
    // the stamp comparison belongs to selectReusableChunks.
    expect(isCapturableFile({ ...live, embeddingModel: ADA } as never)).toBe(true);
  });
});

describe('selectReusableChunks', () => {
  const chunk = (over: Partial<StoredChunk> & { chunkId: string }): StoredChunk => ({
    docId: 'docA',
    text: 'x',
    vector: [1, 0, 0],
    parentEmbeddingModel: ADA,
    ...over,
  });

  it('keeps chunks whose parent stamp is exactly the arm model', () => {
    const sel = selectReusableChunks([chunk({ chunkId: 'c1' }), chunk({ chunkId: 'c2' })], ADA);
    expect(sel.reusable.map(c => c.chunkId)).toEqual(['c1', 'c2']);
    expect(totalExcluded(sel.excluded)).toBe(0);
  });

  it('excludes an UNLABELED chunk rather than assuming it, unlike the retrieval path', () => {
    // Retrieval gives an unknown label the benefit of the doubt because refusing would empty every
    // legacy lake. A measurement has the opposite duty: an unknown vector folded into a baseline
    // measures a band across two spaces at once and reports it as one number.
    const sel = selectReusableChunks(
      [chunk({ chunkId: 'c1', parentEmbeddingModel: undefined }), chunk({ chunkId: 'c2', parentEmbeddingModel: '  ' })],
      ADA
    );
    expect(sel.reusable).toEqual([]);
    expect(sel.excluded.unlabeled).toBe(2);
  });

  it('excludes a foreign-stamped chunk', () => {
    const sel = selectReusableChunks([chunk({ chunkId: 'c1', parentEmbeddingModel: SMALL })], ADA);
    expect(sel.reusable).toEqual([]);
    expect(sel.excluded.modelMismatch).toBe(1);
  });

  it('excludes a chunk that was never embedded', () => {
    const sel = selectReusableChunks([chunk({ chunkId: 'c1', vector: [] })], ADA);
    expect(sel.excluded.missingVector).toBe(1);
  });

  it('excludes a right-labelled vector of the wrong width, because the label can lie', () => {
    const sel = selectReusableChunks([chunk({ chunkId: 'c1', vector: [1, 0] })], ADA, 3);
    expect(sel.excluded.dimensionMismatch).toBe(1);
    expect(sel.reusable).toEqual([]);
  });

  it('checks the model before the width, so a foreign chunk reports the actionable reason', () => {
    const sel = selectReusableChunks([chunk({ chunkId: 'c1', parentEmbeddingModel: SMALL, vector: [1] })], ADA, 3);
    expect(sel.excluded.modelMismatch).toBe(1);
    expect(sel.excluded.dimensionMismatch).toBe(0);
  });

  it('counts a document as dropped only when every one of its chunks was excluded', () => {
    const sel = selectReusableChunks(
      [
        chunk({ chunkId: 'c1', docId: 'kept' }),
        chunk({ chunkId: 'c2', docId: 'kept', parentEmbeddingModel: SMALL }),
        chunk({ chunkId: 'c3', docId: 'gone', parentEmbeddingModel: SMALL }),
      ],
      ADA
    );
    expect(sel.reusable.map(c => c.chunkId)).toEqual(['c1']);
    expect(sel.excludedDocs).toBe(1);
  });

  it('trims the stamp, matching the shared predicate', () => {
    const sel = selectReusableChunks([chunk({ chunkId: 'c1', parentEmbeddingModel: ` ${ADA} ` })], ADA);
    expect(sel.reusable).toHaveLength(1);
  });
});

describe('parseSupportedModels', () => {
  it('accepts registered models and returns them narrowed', () => {
    expect(parseSupportedModels([SMALL, LARGE, ADA])).toEqual([SMALL, LARGE, ADA]);
  });

  it('names the offending value instead of failing opaquely inside the factory later', () => {
    expect(() => parseSupportedModels([SMALL, 'text-embedding-4-enormous'])).toThrow(/text-embedding-4-enormous/);
  });
});

describe('chunkTokenCount', () => {
  it('uses the stored count when the chunk has one, including a legitimate zero', () => {
    expect(chunkTokenCount(550, 'x'.repeat(2200))).toBe(550);
    expect(chunkTokenCount(0, '')).toBe(0);
  });

  it('falls back on chars/3, the shipped estimate, so a firing over-quotes rather than under-quotes', () => {
    // chars/4 (an earlier version of this line) would have quoted 550 for the same passage and fed
    // that to the oversize guard too - optimistic in both places that must not be.
    expect(chunkTokenCount(undefined, 'x'.repeat(2200))).toBe(734);
    expect(chunkTokenCount(null, 'x'.repeat(2200))).toBe(734);
    expect(chunkTokenCount(undefined, 'x'.repeat(2200))).toBeGreaterThan(2200 / 4);
  });
});

describe('findOversizedChunks', () => {
  it('names the chunk the provider would refuse, which its own error cannot', () => {
    const over = findOversizedChunks([
      { chunkId: 'a', tokenCount: 500 },
      { chunkId: 'b', tokenCount: OPENAI_MAX_TOKENS_PER_INPUT + 1 },
    ]);
    expect(over.map(c => c.chunkId)).toEqual(['b']);
  });

  it('passes a chunk exactly at the ceiling - the provider accepts it', () => {
    expect(findOversizedChunks([{ chunkId: 'a', tokenCount: OPENAI_MAX_TOKENS_PER_INPUT }])).toEqual([]);
  });
});

describe('modalLength', () => {
  it('reads the corpus width off the majority rather than off the first vector', () => {
    expect(modalLength([512, 1536, 1536, 1536])).toBe(1536);
  });

  it('breaks an exact tie deterministically, not on Mongo document order', () => {
    // The lake read has no sort, so insertion order IS document order. Both orders must agree.
    expect(modalLength([512, 512, 1536, 1536])).toBe(1536);
    expect(modalLength([1536, 1536, 512, 512])).toBe(1536);
  });

  it('returns undefined for no vectors, i.e. no width guard for the caller to apply', () => {
    expect(modalLength([])).toBeUndefined();
  });

  it('returns the only width there is', () => {
    expect(modalLength([1536, 1536])).toBe(1536);
  });
});

describe('embedAll', () => {
  const vector = (n: number) => [n, n, n];

  it('uses the provider batch path when it has one, in one call', async () => {
    const generateEmbeddingBatch = vi.fn(async (texts: string[]) => texts.map((_, i) => vector(i)));
    const service = {
      generateEmbeddingBatch,
      generateEmbedding: vi.fn(),
      getModelInfo: vi.fn(),
    } as unknown as EmbeddingService;

    expect(await embedAll(service, ['a', 'b'])).toEqual([vector(0), vector(1)]);
    expect(generateEmbeddingBatch).toHaveBeenCalledTimes(1);
    // Token counts are deliberately not forwarded: the batcher recalculates with tiktoken, which
    // beats the counts this harness holds. See embedAll's docblock.
    expect(generateEmbeddingBatch).toHaveBeenCalledWith(['a', 'b']);
  });

  it('falls back to the one-at-a-time contract every provider implements', async () => {
    const generateEmbedding = vi.fn(async (text: string) => vector(text.length));
    const service = { generateEmbedding, getModelInfo: vi.fn() } as unknown as EmbeddingService;

    expect(await embedAll(service, ['a', 'bb'])).toEqual([vector(1), vector(2)]);
    expect(generateEmbedding).toHaveBeenCalledTimes(2);
  });
});

describe('assertOnePerInput', () => {
  it('accepts one vector per input', () => {
    expect(() => assertOnePerInput([[1], [2]], 2, 'chunks')).not.toThrow();
  });

  it('rejects a short batch, which JSON.stringify would otherwise drop silently', () => {
    expect(() => assertOnePerInput([[1]], 2, 'chunks')).toThrow(/expected 2 vectors/);
  });

  it('rejects an empty vector, which is not an embedding of anything', () => {
    expect(() => assertOnePerInput([[1], []], 2, 'probe queries')).toThrow(/probe queries/);
  });
});

describe('toBatches', () => {
  it('splits into whole batches and a remainder', () => {
    expect(toBatches(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('is empty for no ids', () => {
    expect(toBatches([], 200)).toEqual([]);
  });

  it('refuses a size that would never advance', () => {
    expect(() => toBatches(['a'], 0)).toThrow(/at least 1/);
  });
});

describe('readAllPages', () => {
  const page = (ids: string[]) => ids.map(id => ({ id }));

  it('walks the cursor until a short page ends it', async () => {
    const pages = [page(['1', '2']), page(['3', '4']), page(['5'])];
    const seen: (string | undefined)[] = [];
    const all = await readAllPages(async after => {
      seen.push(after);
      return pages.shift() ?? [];
    }, 2);

    expect(all.map(r => r.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(seen).toEqual([undefined, '2', '4']);
  });

  it('stops on an empty first page', async () => {
    expect(await readAllPages(async () => [], 2)).toEqual([]);
  });

  // A full page that does not move the cursor is an infinite loop on a credentialed run, where the
  // corpus is large enough that nobody would notice it was not progress.
  it('throws rather than spin on a non-advancing cursor', async () => {
    await expect(readAllPages(async () => page(['1', '2']), 2)).rejects.toThrow(/without advancing/);
  });
});
