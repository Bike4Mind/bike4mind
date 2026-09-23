import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildLakeMemoryContext, findingSourceRef } from '@bike4mind/common';
import { makeFakeLedger, makeFakeKeyring } from '@server/memory/__tests__/utils/ledgerDoubles';

/**
 * The CROSS-SEAM claim, which the unit suites cannot make.
 *
 * `recordFindingResolutionBelief.test.ts` mocks the append session, and the route suites mock the
 * recorder - so between them every argument is pinned and nothing proves the product promise: that a
 * curator's sentence, once ruled, comes back as a folded belief and reaches the model's turn. Each
 * seam could be individually correct and the chain still broken (a subject that forks on every
 * write, a fact that never survives the fold, a belief the context builder drops).
 *
 * So this runs the REAL composition, the REAL append, the REAL crypto and the REAL fold, against an
 * in-memory ledger and keyring. Only the two module-level singletons the write path reaches for are
 * substituted, because they are the I/O - everything between them is the code under test.
 */

const h = vi.hoisted(() => {
  const ledger = { repo: null as unknown, store: [] as unknown[] };
  const keyring = { provider: null as unknown };
  return {
    ledger,
    keyring,
    getSettingsValue: vi.fn(async () => true),
    getEffectiveLLMApiKeys: vi.fn(async () => ({})),
    embed: vi.fn(async () => undefined),
  };
});

vi.mock('@bike4mind/database', () => ({
  memoryLedgerRepository: new Proxy({}, { get: (_t, prop) => (h.ledger.repo as never)[prop] }),
  memoryPrincipalKeyRepository: {},
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  apiKeyRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: h.getEffectiveLLMApiKeys } }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
// The keyring is the one piece that must stay fake: the real provider talks to KMS. Everything it
// wraps - the AES sealing in `factCipher`, the chain hashing, the fold - runs for real.
vi.mock('@server/memory/factCipher', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/memory/factCipher')>()),
  createKeyProvider: () => h.keyring.provider,
}));
vi.mock('@server/memory/mementoEmbedder', () => ({ createMementoEmbedder: () => h.embed }));
// Recall's QUERY embedder, distinct from the write-path one above. Stubbed to an empty vector so
// recall degrades to the lexical scorer: deterministic, and it keeps the cosine floor (calibrated for
// a real embedding space) out of a test that is about source filtering, not ranking.
vi.mock('@server/memory/mementoQueryEmbedding', () => ({
  embedMementoQuery: vi.fn(async () => ({ vector: [] as number[], model: '' })),
}));

import { recordFindingResolutionBelief } from './recordFindingResolutionBelief';
import { createLedgerMemoryStore } from '@server/memory/ledgerMemoryStore';
import { recallLakeMemory } from '@server/memory/recallLakeMemory';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const LAKE_TAG = 'datalake:acme-research';
const OWNER = 'lake-creator';

const lake = { id: 'lakeDoc1', datalakeTag: LAKE_TAG, createdByUserId: OWNER, lakeMemoryEnabled: true };

const findingOf = (over: Record<string, unknown> = {}) => ({
  id: 'finding-7',
  lakeId: 'lakeDoc1',
  kind: 'metric-disagreement',
  subject: 'q3 revenue',
  sources: [{ fabFileId: 'file-a' }, { fabFileId: 'file-b' }],
  ...over,
});

const record = (over: Record<string, unknown> = {}) =>
  recordFindingResolutionBelief(
    {
      lake,
      finding: findingOf(),
      status: 'resolved',
      resolution: 'Different fiscal years; both are current.',
      startedAt: new Date(),
      ...over,
    } as never,
    { logger } as never
  );

const readLakeProfile = () =>
  createLedgerMemoryStore({
    ledger: h.ledger.repo as never,
    keys: h.keyring.provider as never,
    ownerUserId: OWNER,
  }).readProfile({ kind: 'lake', id: LAKE_TAG });

beforeEach(() => {
  vi.clearAllMocks();
  const ledger = makeFakeLedger();
  h.ledger.repo = ledger.repo;
  h.ledger.store = ledger.store;
  h.keyring.provider = makeFakeKeyring().provider;
  h.getSettingsValue.mockResolvedValue(true);
  h.getEffectiveLLMApiKeys.mockResolvedValue({});
  h.embed.mockResolvedValue(undefined);
});

describe("a curator's ruling, from the click to the model's turn (#3049)", () => {
  it("folds into a belief carrying the curator's own sentence, and renders into the turn", async () => {
    await expect(record()).resolves.toEqual({ recorded: true });

    const profile = await readLakeProfile();
    expect(profile?.beliefs).toHaveLength(1);

    const [belief] = profile!.beliefs;
    // The product claim: what a curator typed is what comes back, framed as a human ruling rather
    // than as another extracted claim - recall injects only this text, so the frame is the only way
    // the model can tell it outranks the documents it contradicts.
    expect(belief.fact).toContain('Different fiscal years; both are current.');
    expect(belief.fact).toContain('curator');
    expect(belief.fact).toContain('metric-disagreement');
    expect(belief.evidenceTier).toBe('human-reviewed');

    // And it survives the last seam, which is what actually puts it in front of the model.
    const rendered = buildLakeMemoryContext([belief.fact]);
    expect(rendered).toContain('Different fiscal years; both are current.');
  });

  it('keeps provenance for both source documents and the finding', async () => {
    await record();

    const [belief] = (await readLakeProfile())!.beliefs;
    expect(belief.sources).toEqual(['file-a', 'file-b', findingSourceRef('finding-7')]);
  });

  it('comes back through the REAL recall hop, with the finding ref kept out of the id lookup', async () => {
    // The hop the other cases skip by reading the profile directly. `recallLakeMemory` is where the
    // belief's `finding:` ref meets a FabFile-only resolver, so it is the one seam that proves the
    // provenance entry does not cost the belief its recall - and the `isDocumentSource` filter that
    // makes that true (`recallLakeMemory.ts:133`) has no other test.
    await record();

    const resolveReachableSources = vi.fn(async (ids: string[]) => new Set(ids));
    const recalled = await recallLakeMemory({
      userId: 'some-chat-user',
      query: 'fiscal years revenue',
      lakes: [{ datalakeTag: LAKE_TAG, ownerUserId: OWNER }],
      k: 24,
      resolveReachableSources,
    } as never);

    expect(recalled).toHaveLength(1);
    expect(recalled[0].fact).toContain('Different fiscal years; both are current.');

    // The load-bearing half: the resolver is FabFile-only, so handing it `finding:finding-7` logs
    // `skipping ids that cannot address a row by _id` on every recall turn. Asserting on the argument
    // rather than only on the result is what catches a deleted filter - the belief would still be
    // recalled via its document ids, so an outcome-only assertion passes either way.
    const lookedUp = resolveReachableSources.mock.calls[0][0];
    expect(lookedUp).toEqual(expect.arrayContaining(['file-a', 'file-b']));
    expect(lookedUp).not.toContain(findingSourceRef('finding-7'));
  });

  it('drops a belief whose only DOCUMENT source has become unreachable', async () => {
    // The reachability gate still bites through the filter: the `finding:` ref must not be able to
    // keep an otherwise-orphaned belief alive, which is what counting it as a source would do.
    await record();

    const recalled = await recallLakeMemory({
      userId: 'some-chat-user',
      query: 'fiscal years revenue',
      lakes: [{ datalakeTag: LAKE_TAG, ownerUserId: OWNER }],
      k: 24,
      resolveReachableSources: async () => new Set<string>(),
    } as never);

    expect(recalled).toEqual([]);
  });

  it('coalesces a REPLAY of the same finding onto one belief, with the latest wording', async () => {
    // What the `/belief` route promises. Two beliefs here would mean the retro-fill door mints a
    // duplicate every time someone clicks it.
    await record();
    await record({ finding: findingOf(), resolution: 'Amended: the 4.4m figure is the restated one.' });

    const profile = await readLakeProfile();
    expect(profile?.beliefs).toHaveLength(1);
    expect(profile!.beliefs[0].fact).toContain('Amended: the 4.4m figure is the restated one.');
  });

  it('keeps TWO findings apart even when ruled with byte-identical notes', async () => {
    // The collision the content-derived subject could not prevent: same kind, same status, same
    // note. Folding these into one would silently destroy the first finding's belief and its
    // provenance, and nothing downstream would report it.
    await record({ finding: findingOf({ id: 'finding-7' }) });
    await record({ finding: findingOf({ id: 'finding-8', sources: [{ fabFileId: 'file-c' }] }) });

    const profile = await readLakeProfile();
    expect(profile?.beliefs).toHaveLength(2);
    expect(profile!.beliefs.flatMap(b => b.sources ?? [])).toEqual(
      expect.arrayContaining([findingSourceRef('finding-7'), findingSourceRef('finding-8'), 'file-c'])
    );
  });

  it('refuses the write when the lake was purged mid-request, rather than resurrecting it', async () => {
    // The fence, end to end. The purge lands AFTER the request arrived, so the belief must not be
    // written - and, critically, the destroyed key must not be re-minted to write it.
    const startedAt = new Date(Date.now() - 1000);
    await (h.keyring.provider as { destroyDek: (p: unknown, at: Date) => Promise<void> }).destroyDek(
      { kind: 'lake', id: LAKE_TAG },
      new Date()
    );

    await expect(record({ startedAt })).resolves.toEqual({ recorded: false, reason: 'shred-fence' });
    expect(await readLakeProfile()).toBeNull();
  });
});
