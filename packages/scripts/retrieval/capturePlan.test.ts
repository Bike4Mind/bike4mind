import { describe, expect, it, vi, afterEach } from 'vitest';
import { OpenAIEmbeddingModel, OllamaEmbeddingModel, getEmbeddingModelCost } from '@bike4mind/common';
import {
  assertSupportedModels,
  formatCapturePlan,
  planCapture,
  selectReusableChunks,
  totalExcluded,
  type StoredChunk,
} from './capturePlan';

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

  it('counts chunks and batches at the provider request ceiling', () => {
    const plan = planCapture(new Array(5000).fill(10), [SMALL]);
    expect(plan.chunks).toBe(5000);
    expect(plan.perModel[0].tokens).toBe(50_000);
    expect(plan.perModel[0].batches).toBe(3); // 2048 inputs per request
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

  it('does not call a zero-token plan unpriced', () => {
    expect(planCapture([], [SMALL]).anyUnpriced).toBe(false);
  });

  it('renders a plan a human can approve from', () => {
    const text = formatCapturePlan(planCapture([1000, 1000], [SMALL, LARGE]));
    expect(text).toContain('chunks to embed      : 2');
    expect(text).toContain(SMALL);
    expect(text).toContain(LARGE);
    expect(text).toMatch(/TOTAL {16}: \$\d/);
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

describe('assertSupportedModels', () => {
  it('accepts registered models', () => {
    expect(() => assertSupportedModels([SMALL, LARGE, ADA])).not.toThrow();
  });

  it('names the offending value instead of failing opaquely inside the factory later', () => {
    expect(() => assertSupportedModels([SMALL, 'text-embedding-4-enormous'])).toThrow(/text-embedding-4-enormous/);
  });
});
