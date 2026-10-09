import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted: vi.mock factories are lifted above plain top-level consts, so a factory reading this
// directly would hit it uninitialized.
const { PINNED } = vi.hoisted(() => ({ PINNED: 'memento-pinned-v1' }));

let docs: Array<{ _id: string; summary: string; embedding?: number[]; embeddingModel?: string }> = [];
const updateOne = vi.fn(async () => ({}));
const generateEmbedding = vi.fn(async () => [0.1, 0.2, 0.3]);
let chain: Array<Record<string, unknown>> = [];
let dek: Buffer | null = Buffer.alloc(32);
let missingKey: string | undefined;
const rewriteEmbedding = vi.fn(async () => 1);

vi.mock('@bike4mind/database', () => ({
  Memento: {
    // `find(...).select(...)` is awaited directly, so a thenable is all the query needs to be.
    find: () => ({ select: () => Promise.resolve(docs) }),
    updateOne: (...a: unknown[]) => updateOne(...(a as [])),
  },
  apiKeyRepository: {},
  adminSettingsRepository: {},
  memoryLedgerRepository: {
    listChain: async () => chain,
    rewriteEmbedding: (...a: unknown[]) => rewriteEmbedding(...(a as [])),
  },
  memoryPrincipalKeyRepository: {},
}));

vi.mock('@bike4mind/common', () => ({
  MEMENTO_EMBEDDING_ID: PINNED,
  MEMENTO_EMBEDDING_MODEL: 'text-embedding-3-small',
  mementoEmbeddingIsCurrent: (m: { embeddingModel?: string }) => m.embeddingModel === PINNED,
  toMementoVector: (v: number[]) => v,
}));

// "Ciphertext" here is the plaintext with a prefix, so the ledger tests can read their own fixtures.
vi.mock('./factCipher', () => ({
  createKeyProvider: () => ({ getDek: async () => dek }),
  decryptFact: (_k: Buffer, s: { cipher: string }) => (s.cipher.startsWith('enc:') ? s.cipher.slice(4) : null),
  decryptVector: () => [9, 9, 9, 9],
  encryptVector: () => ({ cipher: 'vc', iv: 'vi', tag: 'vt' }),
}));

vi.mock('@bike4mind/fab-pipeline', () => ({
  EmbeddingFactory: class {
    createEmbeddingService() {
      return { generateEmbedding: (...a: unknown[]) => generateEmbedding(...(a as [])) };
    }
  },
  getProviderFromModel: () => 'openai',
  resolveEmbeddingConfig: () => ({ config: {}, missing: missingKey }),
}));

vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) } }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));

import { migrateLedgerVectorsForPrincipal, reembedMementosForUser } from './reembedMementos';

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

describe('migrateLedgerVectorsForPrincipal', () => {
  const lake = { principal: { kind: 'lake' as const, id: 'lake:a' }, ownerUserId: 'owner1' };
  const ev = (hash: string, over: Record<string, unknown> = {}) => ({
    hash,
    kind: 'assert',
    factCipher: `enc:fact ${hash}`,
    factIv: 'i',
    factTag: 't',
    ...over,
  });
  const vec = (model?: string) => ({
    embeddingCipher: 'c',
    embeddingIv: 'i',
    embeddingTag: 't',
    embeddingModel: model,
  });

  beforeEach(() => {
    generateEmbedding.mockClear();
    rewriteEmbedding.mockReset();
    rewriteEmbedding.mockResolvedValue(1);
    chain = [];
    dek = Buffer.alloc(32);
    missingKey = undefined;
  });

  it('backfills a vectorless event on a lake chain, writing under the lake principal and owner', async () => {
    chain = [ev('h1')];

    const stats = await migrateLedgerVectorsForPrincipal(lake);

    expect(stats).toMatchObject({ backfilled: 1, failed: 0 });
    expect(generateEmbedding).toHaveBeenCalledWith('fact h1');
    expect(rewriteEmbedding).toHaveBeenCalledWith('lake', 'lake:a', 'owner1', 'h1', {
      cipher: 'vc',
      iv: 'vi',
      tag: 'vt',
      model: PINNED,
    });
  });

  it('classifies every arm: current, truncation, re-embed, legacy plaintext, no fact, skipped', async () => {
    chain = [
      ev('cur', vec(PINNED)),
      ev('full', vec('text-embedding-3-small')),
      ev('ada', vec()),
      { hash: 'legacy', kind: 'assert', fact: 'plain fact' },
      ev('bad', { factCipher: 'garbled' }),
      ev('ret', { kind: 'retract' }),
      ev('shr', { shredded: true }),
    ];

    const stats = await migrateLedgerVectorsForPrincipal(lake);

    expect(stats).toMatchObject({
      total: 7,
      alreadyCurrent: 1,
      truncated: 1,
      reembedded: 1,
      backfilled: 1,
      noFact: 1,
      failed: 0,
    });
    expect(generateEmbedding.mock.calls).toEqual([['fact ada'], ['plain fact']]);
  });

  it('returns empty stats when the principal has no key', async () => {
    dek = null;
    chain = [ev('h1')];

    expect(await migrateLedgerVectorsForPrincipal(lake)).toMatchObject({ backfilled: 0, failed: 0, total: 1 });
    expect(rewriteEmbedding).not.toHaveBeenCalled();
  });

  it('still truncates with no provider key, counting the embeds as noProviderKey and the reason once', async () => {
    missingKey = 'openai';
    chain = [ev('full', vec('text-embedding-3-small')), ev('h1'), ev('h2')];

    const stats = await migrateLedgerVectorsForPrincipal(lake);

    expect(stats).toMatchObject({ truncated: 1, backfilled: 0, noProviderKey: 2, failed: 0, providerCalls: 0 });
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toContain('owner owner1');
  });

  it('spends no limit on a keyless principal, so a long chain is walked to the end', async () => {
    missingKey = 'openai';
    chain = Array.from({ length: 5 }, (_, i) => ev(`h${i}`));

    const stats = await migrateLedgerVectorsForPrincipal(lake, { limit: 2 });

    expect(stats).toMatchObject({ noProviderKey: 5, failed: 0, providerCalls: 0, stoppedAtLimit: false });
  });

  it('makes no provider call and no write on a dry run, but still counts', async () => {
    missingKey = 'openai';
    chain = [ev('full', vec('text-embedding-3-small')), ev('h1')];

    const stats = await migrateLedgerVectorsForPrincipal(lake, { dryRun: true });

    expect(stats).toMatchObject({ truncated: 1, backfilled: 1, failed: 0, errors: [] });
    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(rewriteEmbedding).not.toHaveBeenCalled();
  });

  it('stops at the provider-call limit without charging truncations to it', async () => {
    chain = [ev('full', vec('text-embedding-3-small')), ev('h1'), ev('h2')];

    const stats = await migrateLedgerVectorsForPrincipal(lake, { limit: 1 });

    expect(stats).toMatchObject({ truncated: 1, backfilled: 1, providerCalls: 1, stoppedAtLimit: true });
  });

  it('does not report stoppedAtLimit when the last provider call lands exactly on the limit', async () => {
    chain = [ev('h1'), ev('h2')];

    const stats = await migrateLedgerVectorsForPrincipal(lake, { limit: 2 });

    expect(stats).toMatchObject({ backfilled: 2, stoppedAtLimit: false });
  });

  it('counts a rewrite that matched nothing (e.g. shredded mid-run) as failed', async () => {
    rewriteEmbedding.mockResolvedValue(0);
    chain = [ev('h1')];

    const stats = await migrateLedgerVectorsForPrincipal(lake);

    expect(stats).toMatchObject({ backfilled: 0, failed: 1 });
    expect(stats.errors[0]).toContain('no document matched');
  });
});
