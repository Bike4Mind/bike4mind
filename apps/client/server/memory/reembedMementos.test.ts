import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted: vi.mock factories are lifted above plain top-level consts, so a factory reading this
// directly would hit it uninitialized.
const { PINNED } = vi.hoisted(() => ({ PINNED: 'memento-pinned-v1' }));

let docs: Array<{ _id: string; summary: string; embedding?: number[]; embeddingModel?: string }> = [];
const updateOne = vi.fn(async () => ({}));
const generateEmbedding = vi.fn(async () => [0.1, 0.2, 0.3]);

vi.mock('@bike4mind/database', () => ({
  Memento: {
    // `find(...).select(...)` is awaited directly, so a thenable is all the query needs to be.
    find: () => ({ select: () => Promise.resolve(docs) }),
    updateOne: (...a: unknown[]) => updateOne(...(a as [])),
  },
  apiKeyRepository: {},
  adminSettingsRepository: {},
  memoryLedgerRepository: {},
  memoryPrincipalKeyRepository: {},
}));

vi.mock('@bike4mind/common', () => ({
  MEMENTO_EMBEDDING_ID: PINNED,
  MEMENTO_EMBEDDING_MODEL: 'text-embedding-3-small',
  mementoEmbeddingIsCurrent: (m: { embeddingModel?: string }) => m.embeddingModel === PINNED,
  toMementoVector: (v: number[]) => v,
}));

// Imported by the module for the LEDGER migration below the function under test, not by this path.
vi.mock('./factCipher', () => ({
  createKeyProvider: vi.fn(),
  decryptFact: vi.fn(),
  decryptVector: vi.fn(),
  encryptVector: vi.fn(),
}));

vi.mock('@bike4mind/fab-pipeline', () => ({
  EmbeddingFactory: class {
    createEmbeddingService() {
      return { generateEmbedding: (...a: unknown[]) => generateEmbedding(...(a as [])) };
    }
  },
  getProviderFromModel: () => 'openai',
  resolveEmbeddingConfig: () => ({ config: {}, missing: undefined }),
}));

vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) } }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));

import { reembedMementosForUser } from './reembedMementos';

const stale = (id: string, summary = `summary ${id}`) => ({ id: id, _id: id, summary, embedding: [1, 2] });

describe('reembedMementosForUser', () => {
  beforeEach(() => {
    updateOne.mockClear();
    generateEmbedding.mockClear();
    docs = [];
  });

  it('repairs every stale memento and reports stoppedAtLimit false when unbounded', async () => {
    docs = [stale('m1'), stale('m2'), stale('m3')];

    const stats = await reembedMementosForUser('u1');

    expect(stats).toMatchObject({ total: 3, alreadyCurrent: 0, reembedded: 3, stoppedAtLimit: false });
    expect(updateOne).toHaveBeenCalledTimes(3);
  });

  it('stops at the limit and reports that it did, leaving the rest stale for the next call', async () => {
    docs = [stale('m1'), stale('m2'), stale('m3'), stale('m4'), stale('m5')];

    const stats = await reembedMementosForUser('u1', { limit: 2 });

    expect(stats).toMatchObject({ reembedded: 2, stoppedAtLimit: true });
    // The untouched three keep their old stamp, which is what makes resuming cursor-free.
    expect(updateOne).toHaveBeenCalledTimes(2);
  });

  it('does not spend the budget on a blank-summary skip, which costs no provider call', async () => {
    // The distinction the ceiling rests on: budgeting per memento EXAMINED would let a user holding
    // many unrepairable blanks burn a whole request's allowance without repairing anything, and the
    // operator loop would crawl through them one page at a time.
    docs = [stale('m1', '   '), stale('m2', ''), stale('m3')];

    const stats = await reembedMementosForUser('u1', { limit: 1 });

    expect(stats).toMatchObject({ skippedEmpty: 2, reembedded: 1, stoppedAtLimit: false });
    expect(generateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('spends the budget on a failed memento, since the provider call was made either way', async () => {
    docs = [stale('m1'), stale('m2')];
    generateEmbedding.mockRejectedValueOnce(new Error('429 rate limited'));

    const stats = await reembedMementosForUser('u1', { limit: 1 });

    expect(stats).toMatchObject({ failed: 1, reembedded: 0, stoppedAtLimit: true });
    expect(stats.errors[0]).toContain('429 rate limited');
    // The second memento is never attempted: the failure already consumed the allowance.
    expect(generateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('counts an already-current memento without embedding it', async () => {
    docs = [{ _id: 'm1', summary: 's', embedding: [1], embeddingModel: PINNED }, stale('m2')];

    const stats = await reembedMementosForUser('u1');

    expect(stats).toMatchObject({ total: 2, alreadyCurrent: 1, reembedded: 1 });
    expect(generateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('makes no provider call on a dry run', async () => {
    docs = [stale('m1'), stale('m2')];

    const stats = await reembedMementosForUser('u1', { dryRun: true });

    expect(stats).toMatchObject({ total: 2, alreadyCurrent: 0, reembedded: 0, stoppedAtLimit: false });
    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });
});
