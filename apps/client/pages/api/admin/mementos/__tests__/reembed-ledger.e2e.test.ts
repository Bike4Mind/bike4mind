// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMocks } from 'node-mocks-http';
import { MEMENTO_EMBEDDING_DIMS, MEMENTO_EMBEDDING_ID, MEMENTO_EMBEDDING_MODEL } from '@bike4mind/common';
import { memoryLedgerRepository, memoryPrincipalKeyRepository } from '@bike4mind/database';
import { verifyChain, type MemoryEventInput, type Principal } from '@bike4mind/memory';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { createKeyProvider, decryptFact, encryptVector } from '@bike4mind/server-utils/memory/factCipher';
import { appendMemoryEvent, createLedgerMemoryStore } from '@bike4mind/server-utils/memory/ledgerMemoryStore';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Everything below the provider is real: Mongo, the repository, the keyring, the cipher and the
// service. Only the paid embedding call and the auth middleware are stood in.
const generateEmbedding = vi.fn(async (text: string) => Array.from({ length: 1536 }, (_, i) => (i + text.length) % 7));
vi.mock('@bike4mind/fab-pipeline', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/fab-pipeline')>()),
  resolveEmbeddingConfig: () => ({ config: {}, missing: undefined }),
  EmbeddingFactory: class {
    createEmbeddingService() {
      return { generateEmbedding };
    }
  },
}));
// The owner's key lookup is the first step of building the embedding service.
const getEffectiveLLMApiKeys = vi.fn(async (): Promise<Record<string, string>> => ({}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    apiKeyService: { ...actual.apiKeyService, getEffectiveLLMApiKeys: () => getEffectiveLLMApiKeys() },
  };
});
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));

import handler from '../reembed-ledger';

let mongoServer: MongoMemoryServer;
beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
  generateEmbedding.mockClear();
  getEffectiveLLMApiKeys.mockClear();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const keys = () => createKeyProvider(memoryPrincipalKeyRepository);

async function seed(principal: Principal, owner: string, subject: string, extra: Partial<MemoryEventInput> = {}) {
  await appendMemoryEvent(
    memoryLedgerRepository,
    keys(),
    owner,
    { principal, kind: 'assert', subject, fact: `fact about ${subject}`, at: new Date().toISOString(), ...extra },
    { startedAt: new Date() }
  );
}

async function post(body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- node-mocks-http req has no user field
  (req as any).user = { id: 'admin-1', isAdmin: true };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- baseApi is mocked to the bare handler
  await (handler as any)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() };
}

// Run the operator loop exactly as documented: POST { execute, after: nextAfter } until !hasMore.
async function runLoop(execute: boolean) {
  const pages = [];
  let after: unknown;
  for (let i = 0; i < 20; i++) {
    const page = await post({ execute, after });
    expect(page.status).toBe(200);
    pages.push(page.body);
    if (!page.body.hasMore) return pages;
    after = page.body.nextAfter;
  }
  throw new Error('operator loop did not terminate');
}

async function verified(principal: Principal, owner: string) {
  const dek = await keys().getDek(principal);
  const docs = await memoryLedgerRepository.listChain(principal.kind, principal.id, owner);
  const chain = docs.map(d => ({
    principal,
    kind: d.kind,
    subject: d.subject,
    fact: d.factCipher
      ? (decryptFact(dek!, { cipher: d.factCipher, iv: d.factIv!, tag: d.factTag! }) ?? undefined)
      : d.fact,
    at: d.at,
    sources: d.sources,
    hash: d.hash,
    prevHash: d.prevHash,
    salt: d.salt ?? '',
    commitment: d.commitment ?? '',
    shredded: d.shredded,
  }));
  return { docs, ok: verifyChain(chain).ok };
}

describe('POST /api/admin/mementos/reembed-ledger against a real ledger', () => {
  const lake: Principal = { kind: 'lake', id: 'lake-1' };
  const user: Principal = { kind: 'user', id: 'user-1' };
  const agent: Principal = { kind: 'agent', id: 'agent-1' };

  it('backfills vectorless events for lake, user and agent principals without touching the chain', async () => {
    await seed(lake, 'lake-owner', 'pricing', { sources: ['file-a'] });
    await seed(lake, 'lake-owner', 'roadmap', { sources: ['file-b'] });
    await seed(user, 'user-1', 'woodworking');
    await seed(agent, 'user-1', 'tone');
    await memoryLedgerRepository.markSourceShredded('lake', 'lake-1', 'lake-owner', 'file-b');
    const before = await verified(lake, 'lake-owner');
    expect(before.ok).toBe(true);

    const [dry] = await runLoop(false);
    expect(dry).toMatchObject({ dryRun: true, processedPrincipals: 3, backfilled: 3, failed: 0, hasMore: false });
    expect(generateEmbedding).not.toHaveBeenCalled();
    expect((await memoryLedgerRepository.listChain('lake', 'lake-1', 'lake-owner'))[0].embeddingCipher).toBeFalsy();

    const [run] = await runLoop(true);
    expect(run).toMatchObject({ dryRun: false, processedPrincipals: 3, backfilled: 3, failed: 0, hasMore: false });
    expect(generateEmbedding).toHaveBeenCalledTimes(3);

    for (const [principal, owner] of [
      [lake, 'lake-owner'],
      [user, 'user-1'],
      [agent, 'user-1'],
    ] as const) {
      const profile = await createLedgerMemoryStore({
        ledger: memoryLedgerRepository,
        keys: keys(),
        ownerUserId: owner,
      }).readProfile(principal);
      const live = profile!.beliefs.filter(b => !b.shredded);
      expect(live.length).toBeGreaterThan(0);
      for (const belief of live) expect(belief.embedding).toHaveLength(MEMENTO_EMBEDDING_DIMS);
    }

    const after = await verified(lake, 'lake-owner');
    expect(after.ok).toBe(true);
    expect(after.docs.map(d => [d.hash, d.commitment, d.seq])).toEqual(
      before.docs.map(d => [d.hash, d.commitment, d.seq])
    );
    // The shredded event is never handed a vector.
    expect(after.docs.find(d => d.shredded)!.embeddingCipher).toBeFalsy();

    expect(await memoryLedgerRepository.listPrincipalsNeedingVectors('x', { limit: 10 })).toHaveLength(3);
    expect(await runLoop(true)).toEqual([expect.objectContaining({ processedPrincipals: 0, hasMore: false })]);
  });

  it('dry run counts match execute per arm on a mixed chain', async () => {
    for (const subject of ['current', 'stamped', 'unstamped', 'vectorless', 'partial']) {
      await seed(user, 'user-1', subject);
    }
    const [current, stamped, unstamped, , partial] = await memoryLedgerRepository.listChain('user', 'user-1', 'user-1');
    const dek = (await keys().getDek(user))!;
    const give = async (hash: string, model: string, dims: number) => {
      const sealed = encryptVector(
        dek,
        Array.from({ length: dims }, (_, i) => i / dims)
      );
      await memoryLedgerRepository.rewriteEmbedding('user', 'user-1', 'user-1', hash, { ...sealed, model });
    };
    await give(current.hash, MEMENTO_EMBEDDING_ID, MEMENTO_EMBEDDING_DIMS);
    await give(stamped.hash, MEMENTO_EMBEDDING_MODEL, 1536);
    await give(unstamped.hash, MEMENTO_EMBEDDING_MODEL, 1536);
    // A legacy vector written before the space stamp existed.
    await mongoose.model('MemoryLedgerEvent').updateOne({ hash: unstamped.hash }, { $unset: { embeddingModel: 1 } });
    // An empty tag is not a vector: presence needs all three cipher fields non-empty.
    await give(partial.hash, MEMENTO_EMBEDDING_MODEL, 1536);
    await mongoose.model('MemoryLedgerEvent').updateOne({ hash: partial.hash }, { $set: { embeddingTag: '' } });

    const arms = { alreadyCurrent: 1, truncated: 1, reembedded: 1, backfilled: 2, failed: 0 };
    const [dry] = await runLoop(false);
    expect(dry).toMatchObject({ dryRun: true, processedPrincipals: 1, ...arms });
    const [run] = await runLoop(true);
    expect(run).toMatchObject({ dryRun: false, processedPrincipals: 1, ...arms });
    expect(generateEmbedding).toHaveBeenCalledTimes(3);
  });

  it('resumes a principal cut short by the per-request provider cap', async () => {
    for (let i = 0; i < 105; i++) await seed(user, 'user-1', `s${i}`);

    const pages = await runLoop(true);
    expect(pages.map(p => p.backfilled)).toEqual([100, 5]);
    expect(pages[0]).toMatchObject({ hasMore: true, nextAfter: null });
    expect(generateEmbedding).toHaveBeenCalledTimes(105);
    expect((await verified(user, 'user-1')).ok).toBe(true);
  });

  it('does not treat a transient key-lookup failure as a missing key for the rest of the walk', async () => {
    const lake2: Principal = { kind: 'lake', id: 'lake-2' };
    await seed(lake, 'lake-owner', 'pricing');
    await seed(lake, 'lake-owner', 'roadmap');
    await seed(lake2, 'lake-owner', 'hiring');
    getEffectiveLLMApiKeys.mockRejectedValueOnce(new Error('connection reset'));

    const [run] = await runLoop(true);
    expect(run).toMatchObject({ processedPrincipals: 2, backfilled: 2, embedderUnavailable: 1, noProviderKey: 0 });
    expect(run.failedPrincipals).toEqual([
      expect.objectContaining({ principalId: 'lake-1', error: expect.stringContaining('retried next walk') }),
    ]);

    // The event the failed build skipped is still vectorless, so the next walk picks it up.
    const [again] = await runLoop(true);
    expect(again).toMatchObject({ processedPrincipals: 1, backfilled: 1, embedderUnavailable: 0 });
  });
});
