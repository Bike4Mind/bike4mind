import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ContextSummarizationFeature,
  KnowledgeRetrievalFeature,
  MementoFeature,
  SessionPromptFeature,
  shouldSummarizeSession,
  SUMMARIZATION_CONFIG,
} from './ChatCompletionFeatures';
import type { ISessionDocument, IChatHistoryItemDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

const makeQuest = (overrides: Partial<IChatHistoryItemDocument> = {}): IChatHistoryItemDocument =>
  ({
    id: 'quest1',
    sessionId: 'session1',
    prompt: 'test prompt',
    replies: ['test reply'],
    type: 'message',
    status: 'done',
    timestamp: new Date(),
    ...overrides,
  }) as unknown as IChatHistoryItemDocument;

const makeSession = (overrides: Partial<ISessionDocument> = {}): ISessionDocument =>
  ({
    id: 'session1',
    messageCount: 100,
    ...overrides,
  }) as unknown as ISessionDocument;

const makeArgs = (overrides: Record<string, unknown> = {}) => ({
  quest: makeQuest(),
  session: makeSession({ messageCount: 100 }),
  messages: [],
  questMaster: undefined,
  model: 'claude-sonnet-4-6',
  historyCount: 20,
  oldestIncludedQuestId: '000000000000000000000005',
  ...overrides,
});

describe('ContextSummarizationFeature', () => {
  let contextSummarizeSession: ReturnType<typeof vi.fn>;
  let feature: ContextSummarizationFeature;

  beforeEach(() => {
    contextSummarizeSession = vi.fn().mockResolvedValue(undefined);
    feature = new ContextSummarizationFeature({ contextSummarizeSession } as unknown as Parameters<
      typeof ContextSummarizationFeature.prototype.constructor
    >[0]);
  });

  describe('beforeDataGathering', () => {
    it('always returns shouldContinue: true', async () => {
      const result = await feature.beforeDataGathering();
      expect(result).toEqual({ shouldContinue: true });
    });
  });

  describe('getContextMessages', () => {
    it('always returns an empty array', async () => {
      const result = await feature.getContextMessages();
      expect(result).toEqual([]);
    });
  });

  describe('onComplete', () => {
    it('calls contextSummarizeSession when overflow is detected and boundary is present', async () => {
      await feature.onComplete(makeArgs());

      expect(contextSummarizeSession).toHaveBeenCalledOnce();
      expect(contextSummarizeSession).toHaveBeenCalledWith('session1', '000000000000000000000005');
    });

    it('does NOT call contextSummarizeSession when historyCount is missing', async () => {
      await feature.onComplete(makeArgs({ historyCount: undefined }));
      expect(contextSummarizeSession).not.toHaveBeenCalled();
    });

    it('does NOT call contextSummarizeSession when historyCount is 0', async () => {
      await feature.onComplete(makeArgs({ historyCount: 0 }));
      expect(contextSummarizeSession).not.toHaveBeenCalled();
    });

    it('does NOT call contextSummarizeSession when oldestIncludedQuestId is null', async () => {
      await feature.onComplete(makeArgs({ oldestIncludedQuestId: null }));
      expect(contextSummarizeSession).not.toHaveBeenCalled();
    });

    it('does NOT call contextSummarizeSession when oldestIncludedQuestId is undefined', async () => {
      await feature.onComplete(makeArgs({ oldestIncludedQuestId: undefined }));
      expect(contextSummarizeSession).not.toHaveBeenCalled();
    });

    it('does NOT call contextSummarizeSession when no overflow (messageCount <= historyCount)', async () => {
      await feature.onComplete(
        makeArgs({
          session: makeSession({ messageCount: 20 }),
          historyCount: 20,
        })
      );
      expect(contextSummarizeSession).not.toHaveBeenCalled();
    });

    it('does NOT call contextSummarizeSession when messageCount is missing from session', async () => {
      await feature.onComplete(
        makeArgs({
          session: makeSession({ messageCount: undefined }),
        })
      );
      expect(contextSummarizeSession).not.toHaveBeenCalled();
    });

    it('does NOT call contextSummarizeSession when summarized less than 5 minutes ago', async () => {
      const recentSummaryAt = new Date(Date.now() - 2 * 60_000); // 2 minutes ago
      await feature.onComplete(
        makeArgs({
          session: makeSession({ messageCount: 100, contextSummaryAt: recentSummaryAt }),
        })
      );
      expect(contextSummarizeSession).not.toHaveBeenCalled();
    });

    it('calls contextSummarizeSession when last summarization was exactly 5 minutes ago', async () => {
      const oldSummaryAt = new Date(Date.now() - 5 * 60_000); // exactly 5 minutes ago
      await feature.onComplete(
        makeArgs({
          session: makeSession({ messageCount: 100, contextSummaryAt: oldSummaryAt }),
        })
      );
      expect(contextSummarizeSession).toHaveBeenCalledOnce();
    });

    it('calls contextSummarizeSession when last summarization was more than 5 minutes ago', async () => {
      const oldSummaryAt = new Date(Date.now() - 10 * 60_000); // 10 minutes ago
      await feature.onComplete(
        makeArgs({
          session: makeSession({ messageCount: 100, contextSummaryAt: oldSummaryAt }),
        })
      );
      expect(contextSummarizeSession).toHaveBeenCalledOnce();
    });

    it('calls contextSummarizeSession when no previous summarization exists', async () => {
      await feature.onComplete(
        makeArgs({
          session: makeSession({ messageCount: 100, contextSummaryAt: undefined }),
        })
      );
      expect(contextSummarizeSession).toHaveBeenCalledOnce();
    });
  });
});

describe('MementoFeature - Mementos V2 injection', () => {
  // The V2 opt-in is stored as a Mongoose Map, and the feature reads it off the in-hand user
  // document (no DB round trip). Model that shape here - a plain object would not exercise the
  // Map-aware read that the chat gate depends on.
  const v2User = (on: boolean) => ({
    id: 'u1',
    preferences: { experimentalFeatures: new Map([['enableMementosV2', on]]) },
  });

  const invokeCreateMemento = vi.fn();
  const makeCtx = (recallMementosV2: unknown, user: unknown = v2User(true)) =>
    ({
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      user,
      db: {},
      recallMementosV2,
      invokeCreateMemento,
      userAbility: {}, // onComplete guards on its presence only
    }) as unknown as ConstructorParameters<typeof MementoFeature>[0];

  // Default WRITE flags for constructions that only exercise the READ path.
  const READ_ONLY = { writeV1: false, writeV2: true };
  beforeEach(() => invokeCreateMemento.mockClear());

  const call = (feature: MementoFeature) =>
    feature.getContextMessages(
      makeQuest(),
      undefined as unknown as Parameters<typeof feature.getContextMessages>[1],
      'what do i like',
      1000,
      undefined as unknown as Parameters<typeof feature.getContextMessages>[4]
    );

  it('injects the V2 union recall as system messages and skips the V1 path', async () => {
    const recallMementosV2 = vi.fn().mockResolvedValue([
      { fact: 'User loves sushi', relevance: 0.9 },
      { fact: 'User works in pharma', relevance: 0.4 },
    ]);
    const messages = await call(new MementoFeature(makeCtx(recallMementosV2), READ_ONLY));
    // The feature hands over the opt-in it already resolved, so the recall need not re-fetch the user.
    expect(recallMementosV2).toHaveBeenCalledWith('u1', 'what do i like', { enabled: true });

    // ONE framed system block carrying both facts - not one `[Memory] ...` note-card per fact. That
    // per-message format (with its `[Memory]` label) was A/B-measured to make the model recite its
    // memory; the single knowledge-framed block scored 0% transcript-talk. See buildMemoryContext.
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('User loves sushi');
    expect(messages[0].content).toContain('User works in pharma');
    expect(messages[0].content).not.toContain('[Memory]');
    expect(messages[0].content).toContain('the way a friend who remembers would');
  });

  it('injects nothing when V2 is on but the recall is empty', async () => {
    const messages = await call(new MementoFeature(makeCtx(vi.fn().mockResolvedValue([])), READ_ONLY));
    expect(messages).toEqual([]);
  });

  it('does NOT take the V2 path for a user who has not opted in', async () => {
    // The regression that kept V2 dark: the flag lives in a Mongoose Map, and a dot-access read of
    // it always yielded undefined, so this gate never fired for anyone. Off must mean off, and on
    // must mean on - both are asserted here.
    const recallMementosV2 = vi.fn().mockResolvedValue([{ fact: 'should not be used', relevance: 1 }]);
    const feature = new MementoFeature(makeCtx(recallMementosV2, v2User(false)), READ_ONLY);

    await call(feature).catch(() => []); // V1 path may fail on the stub db; we only care about the gate

    expect(recallMementosV2).not.toHaveBeenCalled();
  });

  it('onComplete forwards the RESOLVED write flags, so the subscriber cannot re-default V1 on', async () => {
    // The P1 that kept V1 un-deletable: chat published the completion event with NO flags, so the
    // memento subscriber read a missing enableMementos as true and wrote a V1 memento every turn even
    // when V1 was off. The feature now forwards the flags it was constructed with.
    const feature = new MementoFeature(makeCtx(vi.fn().mockResolvedValue([])), { writeV1: false, writeV2: true });
    await feature.onComplete({ quest: makeQuest(), model: 'gpt-5.4' } as never);

    expect(invokeCreateMemento).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'u1',
      expect.anything(),
      'gpt-5.4',
      { enableMementos: false, enableMementosV2: true }
    );
  });
});

describe('shouldSummarizeSession', () => {
  const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

  const makeCtx = (count: ReturnType<typeof vi.fn>) => ({
    db: { quests: { count } },
    logger: silentLogger,
  });

  it('returns earlyMilestone when total quest count hits the milestone with no prior summary', async () => {
    const session = makeSession({ id: 'session1', summaryAt: undefined });
    const count = vi.fn().mockResolvedValueOnce(SUMMARIZATION_CONFIG.earlyMilestoneQuestCount);
    const [shouldRun, trigger] = await shouldSummarizeSession(session, makeCtx(count));
    expect(shouldRun).toBe(true);
    expect(trigger).toBe('earlyMilestone');
    expect(count).toHaveBeenCalledOnce();
    expect(count).toHaveBeenCalledWith({ sessionId: 'session1' });
  });

  it('returns earlyMilestone when imported session starts above the threshold (>= semantics)', async () => {
    const session = makeSession({ id: 'session1', summaryAt: undefined });
    const count = vi.fn().mockResolvedValueOnce(SUMMARIZATION_CONFIG.earlyMilestoneQuestCount + 5);
    const [shouldRun, trigger] = await shouldSummarizeSession(session, makeCtx(count));
    expect(shouldRun).toBe(true);
    expect(trigger).toBe('earlyMilestone');
  });

  it('takes the post-summary branch when a previous summary exists (no earlyMilestone re-fire)', async () => {
    const summaryAt = new Date(Date.now() - 60 * 60_000);
    const session = makeSession({ id: 'session1', summaryAt });
    const count = vi.fn().mockResolvedValueOnce(1);
    const [shouldRun, trigger] = await shouldSummarizeSession(session, makeCtx(count));
    expect(shouldRun).toBe(false);
    expect(trigger).toBeUndefined();
    expect(count).toHaveBeenCalledOnce();
    expect(count).toHaveBeenCalledWith({ sessionId: 'session1', timestamp: { $gt: summaryAt } });
  });

  it('returns contentGrowth when quests since last summary reaches the growth threshold', async () => {
    const session = makeSession({ id: 'session1', summaryAt: new Date(Date.now() - 60 * 60_000) });
    const count = vi.fn().mockResolvedValueOnce(SUMMARIZATION_CONFIG.contentGrowthThreshold);
    const [shouldRun, trigger] = await shouldSummarizeSession(session, makeCtx(count));
    expect(shouldRun).toBe(true);
    expect(trigger).toBe('contentGrowth');
  });

  it('returns throttling without running counts when within minTimeBetweenSummaries', async () => {
    const session = makeSession({ id: 'session1', summaryAt: new Date(Date.now() - 60_000) });
    const count = vi.fn();
    const [shouldRun, trigger] = await shouldSummarizeSession(session, makeCtx(count));
    expect(shouldRun).toBe(false);
    expect(trigger).toBe('throttling');
    expect(count).not.toHaveBeenCalled();
  });

  it('returns [false, undefined] when no triggers are met', async () => {
    const session = makeSession({ id: 'session1', summaryAt: new Date(Date.now() - 60 * 60_000) });
    const count = vi.fn().mockResolvedValueOnce(SUMMARIZATION_CONFIG.contentGrowthThreshold - 1);
    const [shouldRun, trigger] = await shouldSummarizeSession(session, makeCtx(count));
    expect(shouldRun).toBe(false);
    expect(trigger).toBeUndefined();
  });
});

describe('KnowledgeRetrievalFeature citation styles', () => {
  // Two source documents; file A contributes two chunks (both ranked above file B's)
  // so the indexed style must give both A-sections the SAME number and B the next.
  const makeRetrievalContext = () => {
    const files = [
      { id: 'fileA', fileName: 'NCCN NSCLC v3.2026.pdf', tags: [] },
      { id: 'fileB', fileName: 'Cortes NEJM 2024.pdf', tags: [] },
    ];
    const chunksByFile: Record<string, unknown[]> = {
      fileA: [
        { id: 'chA1', fabFileId: 'fileA', text: 'chunk A1', vector: [1, 0] },
        { id: 'chA2', fabFileId: 'fileA', text: 'chunk A2', vector: [0.95, 0.05] },
      ],
      fileB: [{ id: 'chB1', fabFileId: 'fileB', text: 'chunk B1', vector: [0.9, 0.1] }],
    };
    return {
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      user: { id: 'u1', tags: [], groups: [] },
      db: {
        fabfiles: { search: vi.fn().mockResolvedValue({ data: files, hasMore: false, total: files.length }) },
        fabfilechunks: {
          findByFabFileId: vi.fn(),
          findVectorsByFabFileIds: vi.fn((ids: string[]) => Promise.resolve(ids.flatMap(id => chunksByFile[id] ?? []))),
        },
      },
      // Resolver injected by ChatCompletionProcess; no entitlements in these citation tests.
      resolveEntitlementKeys: vi.fn().mockResolvedValue([]),
      sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
    };
  };
  const embeddingFactory = {
    createEmbeddingService: () => ({ generateEmbedding: vi.fn().mockResolvedValue([1, 0]) }),
  };

  const runRetrieval = async (citationStyle?: 'named' | 'indexed') => {
    const ctx = makeRetrievalContext();
    const feature = new KnowledgeRetrievalFeature(
      ctx as unknown as ConstructorParameters<typeof KnowledgeRetrievalFeature>[0],
      undefined,
      citationStyle
    );
    const quest = makeQuest();
    const messages = await feature.getContextMessages(
      quest,
      embeddingFactory as unknown as Parameters<typeof feature.getContextMessages>[1],
      'stage III NSCLC treatment'
    );
    return { quest, content: messages[0]?.content ?? '' };
  };

  it('named (default): sections are headed by file name with no [N], header says cite by name', async () => {
    const { content } = await runRetrieval();
    expect(content).toContain('### NCCN NSCLC v3.2026.pdf (ID: fileA)');
    expect(content).toContain('### Cortes NEJM 2024.pdf (ID: fileB)');
    expect(content).toContain('cite documents by name');
    expect(content).not.toContain('### [1]');
  });

  it('indexed: numbers distinct documents in citables order, same file shares its number', async () => {
    const { quest, content } = await runRetrieval('indexed');
    // Both fileA chunks carry [1]; fileB carries [2].
    expect(content).toContain('### [1] NCCN NSCLC v3.2026.pdf (ID: fileA)');
    expect(content).toContain('### [2] Cortes NEJM 2024.pdf (ID: fileB)');
    expect((content.match(/### \[1\] NCCN/g) ?? []).length).toBe(2);
    // The prompt fragment states the index-only rules with the right count.
    expect(content).toContain('cite ONLY by bracketed index');
    expect(content).toContain('never cite an index above 2');
    // Citables order IS the index order: [N] maps to citables[N-1].
    const citables = (quest.promptMeta as { citables?: Array<{ id: string }> }).citables ?? [];
    expect(citables.map(c => c.id)).toEqual(['fileA', 'fileB']);
  });

  it('indexed: fresh quest keeps forced-retrieval citables as the index-aligned array prefix (no warn)', async () => {
    const ctx = makeRetrievalContext();
    const feature = new KnowledgeRetrievalFeature(
      ctx as unknown as ConstructorParameters<typeof KnowledgeRetrievalFeature>[0],
      undefined,
      'indexed'
    );
    const quest = makeQuest();
    await feature.getContextMessages(
      quest,
      embeddingFactory as unknown as Parameters<typeof feature.getContextMessages>[1],
      'stage III NSCLC treatment'
    );
    const citables = (quest.promptMeta as { citables?: Array<{ id: string }> }).citables ?? [];
    // The [N] maps to citables[N-1] invariant: numbered docs occupy positions 0..k-1 in heading order.
    expect(citables.map(c => c.id)).toEqual(['fileA', 'fileB']);
    expect((ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).not.toHaveBeenCalled();
  });

  it('indexed: forces forced-retrieval citables to the prefix even when citables pre-exist (warns)', async () => {
    const ctx = makeRetrievalContext();
    const feature = new KnowledgeRetrievalFeature(
      ctx as unknown as ConstructorParameters<typeof KnowledgeRetrievalFeature>[0],
      undefined,
      'indexed'
    );
    const quest = makeQuest({
      promptMeta: { citables: [{ id: 'pre-existing', type: 'document', title: 'Earlier source' }] },
    } as unknown as Partial<IChatHistoryItemDocument>);
    await feature.getContextMessages(
      quest,
      embeddingFactory as unknown as Parameters<typeof feature.getContextMessages>[1],
      'stage III NSCLC treatment'
    );
    // Defensive enforcement: the numbered docs MUST occupy positions 0..k-1 ([N] maps to citables[N-1]);
    // the pre-existing citable is appended AFTER, never allowed to shift the index alignment.
    const citables = (quest.promptMeta as { citables?: Array<{ id: string }> }).citables ?? [];
    expect(citables.map(c => c.id)).toEqual(['fileA', 'fileB', 'pre-existing']);
    expect((ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.stringContaining('prefix')
    );
  });

  it('indexed: drops a pre-existing citable that collides (by id) with a numbered one — no duplicate, no shift', async () => {
    const ctx = makeRetrievalContext();
    const feature = new KnowledgeRetrievalFeature(
      ctx as unknown as ConstructorParameters<typeof KnowledgeRetrievalFeature>[0],
      undefined,
      'indexed'
    );
    // Pre-existing citable shares fileA's id: must be de-duplicated, not appended after fileB,
    // so the numbered prefix stays exactly [fileA, fileB] and [N] maps to citables[N-1] is preserved.
    const quest = makeQuest({
      promptMeta: { citables: [{ id: 'fileA', type: 'document', title: 'Stale duplicate of fileA' }] },
    } as unknown as Partial<IChatHistoryItemDocument>);
    await feature.getContextMessages(
      quest,
      embeddingFactory as unknown as Parameters<typeof feature.getContextMessages>[1],
      'stage III NSCLC treatment'
    );
    const citables = (quest.promptMeta as { citables?: Array<{ id: string }> }).citables ?? [];
    expect(citables.map(c => c.id)).toEqual(['fileA', 'fileB']);
  });
});

describe('KnowledgeRetrievalFeature retrieval exclusion (4th ctor arg)', () => {
  // fileB's name starts with the marker "Cortes"; fileA does not. The exclusion must drop
  // fileB from forced grounding AND from the emitted citables, and forward the options to
  // the DB pre-filter. Guards the ctor's positional 4th param (zero coverage before).
  const makeCtx = () => {
    const files = [
      { id: 'fileA', fileName: 'NCCN NSCLC v3.2026.pdf', tags: [], vectorized: true },
      { id: 'fileB', fileName: 'Cortes NEJM 2024.pdf', tags: [], vectorized: true },
    ];
    const chunksByFile: Record<string, unknown[]> = {
      fileA: [{ id: 'chA1', fabFileId: 'fileA', text: 'chunk A1', vector: [1, 0] }],
      fileB: [{ id: 'chB1', fabFileId: 'fileB', text: 'chunk B1', vector: [0.9, 0.1] }],
    };
    return {
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      user: { id: 'u1', tags: [], groups: [] },
      db: {
        fabfiles: { search: vi.fn().mockResolvedValue({ data: files, hasMore: false, total: files.length }) },
        fabfilechunks: {
          findByFabFileId: vi.fn(),
          findVectorsByFabFileIds: vi.fn((ids: string[]) => Promise.resolve(ids.flatMap(id => chunksByFile[id] ?? []))),
        },
      },
      resolveEntitlementKeys: vi.fn().mockResolvedValue([]),
      sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
    };
  };
  const embeddingFactory = {
    createEmbeddingService: () => ({ generateEmbedding: vi.fn().mockResolvedValue([1, 0]) }),
  };

  it('drops a marked file from forced retrieval content + citables, and forwards the DB pre-filter', async () => {
    const ctx = makeCtx();
    const feature = new KnowledgeRetrievalFeature(
      ctx as unknown as ConstructorParameters<typeof KnowledgeRetrievalFeature>[0],
      undefined,
      'named',
      { excludeFilenameMarkers: ['Cortes'] }
    );
    const quest = makeQuest();
    const messages = await feature.getContextMessages(
      quest,
      embeddingFactory as unknown as Parameters<typeof feature.getContextMessages>[1],
      'stage III NSCLC treatment'
    );
    const content = messages[0]?.content ?? '';
    expect(content).toContain('### NCCN NSCLC v3.2026.pdf (ID: fileA)'); // kept
    expect(content).not.toContain('fileB'); // marked file dropped
    expect(content).not.toContain('Cortes');
    const citables = (quest.promptMeta as { citables?: Array<{ id: string }> }).citables ?? [];
    expect(citables.map(c => c.id)).toEqual(['fileA']);
    // Options also reach the DB pre-filter (best-effort), not just the in-memory pass.
    expect(ctx.db.fabfiles.search).toHaveBeenCalledWith(
      'u1',
      '',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ excludeFilenameMarkers: ['Cortes'] })
    );
    // An excluded file must never reach the (expensive) vector read at all.
    expect(ctx.db.fabfilechunks.findVectorsByFabFileIds).toHaveBeenCalledTimes(1);
    expect(ctx.db.fabfilechunks.findVectorsByFabFileIds.mock.calls[0][0]).toEqual(['fileA']);
  });

  it('no filter (default): both files are retrieved (opt-in only)', async () => {
    const ctx = makeCtx();
    const feature = new KnowledgeRetrievalFeature(
      ctx as unknown as ConstructorParameters<typeof KnowledgeRetrievalFeature>[0]
    );
    const quest = makeQuest();
    await feature.getContextMessages(
      quest,
      embeddingFactory as unknown as Parameters<typeof feature.getContextMessages>[1],
      'stage III NSCLC treatment'
    );
    const citables = (quest.promptMeta as { citables?: Array<{ id: string }> }).citables ?? [];
    expect(citables.map(c => c.id).sort()).toEqual(['fileA', 'fileB']);
  });
});

describe('KnowledgeRetrievalFeature bounded scan + coverage reporting', () => {
  const embeddingFactory = {
    createEmbeddingService: () => ({ generateEmbedding: vi.fn().mockResolvedValue([1, 0]) }),
  };

  /** `total` defaults to the listed count, i.e. full coverage, so tests opt in to partiality. */
  const makeCtx = (opts: {
    files?: { id: string; fileName: string; tags?: unknown[]; embeddingModel?: string }[];
    rows?: (ids: string[]) => unknown[];
    total?: number;
  }) => {
    const files = opts.files ?? [{ id: 'fileA', fileName: 'A.pdf', tags: [] }];
    const findVectorsByFabFileIds = vi.fn((ids: string[]) =>
      Promise.resolve(
        opts.rows
          ? opts.rows(ids)
          : ids.map(id => ({ id: `ch-${id}`, fabFileId: id, text: `text ${id}`, vector: [1, 0] }))
      )
    );
    return {
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      user: { id: 'u1', tags: [], groups: [] },
      db: {
        fabfiles: {
          search: vi.fn().mockResolvedValue({ data: files, hasMore: false, total: opts.total ?? files.length }),
        },
        fabfilechunks: { findByFabFileId: vi.fn(), findVectorsByFabFileIds },
      },
      resolveEntitlementKeys: vi.fn().mockResolvedValue([]),
      sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
    };
  };

  const run = async (ctx: ReturnType<typeof makeCtx>, citationStyle?: 'named' | 'indexed') => {
    const feature = new KnowledgeRetrievalFeature(
      ctx as unknown as ConstructorParameters<typeof KnowledgeRetrievalFeature>[0],
      undefined,
      citationStyle
    );
    const quest = makeQuest();
    const messages = await feature.getContextMessages(
      quest,
      embeddingFactory as unknown as Parameters<typeof feature.getContextMessages>[1],
      'stage III NSCLC treatment'
    );
    return { quest, content: messages[0]?.content ?? '', messages };
  };

  it('uses the projected batched reader, never the unbounded per-file read', async () => {
    const ctx = makeCtx({});
    await run(ctx);
    expect(ctx.db.fabfilechunks.findVectorsByFabFileIds).toHaveBeenCalled();
    expect(ctx.db.fabfilechunks.findByFabFileId).not.toHaveBeenCalled();
    // The row cap must be passed, or a single huge file reintroduces the unbounded load.
    expect(ctx.db.fabfilechunks.findVectorsByFabFileIds.mock.calls[0][1]).toEqual(
      expect.objectContaining({ limit: expect.any(Number) })
    );
  });

  it('full coverage stays completely silent: no warn, no promptMeta warning, no coverage note', async () => {
    const ctx = makeCtx({});
    const { quest, content } = await run(ctx);
    expect(content).toContain('### A.pdf (ID: fileA)');
    expect(content).not.toContain('Coverage note');
    expect((ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).not.toHaveBeenCalled();
    expect((quest.promptMeta as { warnings?: string[] }).warnings).toBeUndefined();
  });

  it('a library larger than the candidate cap warns, records a promptMeta warning, and hedges the prompt', async () => {
    const ctx = makeCtx({ total: 2314 });
    const { quest, content } = await run(ctx);
    expect(content).toContain('Coverage note');
    expect(content).toContain('do not state or imply the library was searched exhaustively');
    const warn = (ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PARTIAL coverage'));
    expect(warn.mock.calls[0][0]).toContain('2314');
    expect((quest.promptMeta as { warnings?: string[] }).warnings).toHaveLength(1);
  });

  it('a library exactly at the listed count is complete, not truncated', async () => {
    // Kills the naive `listed === cap => truncated` inversion: equality is full coverage.
    const ctx = makeCtx({ total: 1 });
    const { quest, content } = await run(ctx);
    expect(content).not.toContain('Coverage note');
    expect((ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).not.toHaveBeenCalled();
    expect((quest.promptMeta as { warnings?: string[] }).warnings).toBeUndefined();
  });

  it('skips a wrong-width vector, still grounds on the good one, and reports the mismatch', async () => {
    const ctx = makeCtx({
      files: [
        { id: 'good', fileName: 'Good.pdf', tags: [] },
        { id: 'stale', fileName: 'Stale.pdf', tags: [] },
      ],
      rows: () => [
        { id: 'c1', fabFileId: 'good', text: 'usable content', vector: [1, 0] },
        // 3 dims against a 2-dim query: a different embedding model's vector space.
        { id: 'c2', fabFileId: 'stale', text: 'unmatchable content', vector: [1, 0, 0] },
      ],
    });
    const { content } = await run(ctx);
    expect(content).toContain('usable content');
    expect(content).not.toContain('unmatchable content');
    expect((ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.stringContaining('different dimension')
    );
  });

  it('an entirely wrong-width corpus says so, distinctly from having no vectors at all', async () => {
    const ctx = makeCtx({
      rows: () => [{ id: 'c1', fabFileId: 'fileA', text: 'x', vector: [1, 0, 0] }],
    });
    const { messages } = await run(ctx);
    expect(messages).toEqual([]);
    const warn = (ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('needs re-vectorizing'));
    // Must NOT be reported as "no vectorized chunks" - these files have vectors, at the wrong width.
    const logs = (ctx.logger as unknown as { log: ReturnType<typeof vi.fn> }).log.mock.calls.flat().join(' ');
    expect(logs).not.toContain('no vectorized chunks');
  });

  it('genuinely unvectorized files keep the original message and do not warn', async () => {
    const ctx = makeCtx({ rows: () => [] });
    const { messages } = await run(ctx);
    expect(messages).toEqual([]);
    const logs = (ctx.logger as unknown as { log: ReturnType<typeof vi.fn> }).log.mock.calls.flat().join(' ');
    expect(logs).toContain('no vectorized chunks');
    expect((ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).not.toHaveBeenCalled();
  });

  it('citation [N] numbering is stable when the reader returns rows in a different order', async () => {
    // Batching changed arrival order, so equal-ranked chunks must be ordered by the explicit
    // comparator rather than by whatever order the DB happened to return.
    const rows = [
      { id: 'c1', fabFileId: 'fileA', text: 'alpha', vector: [1, 0] },
      { id: 'c2', fabFileId: 'fileB', text: 'beta', vector: [1, 0] },
    ];
    const files = [
      { id: 'fileA', fileName: 'A.pdf', tags: [] },
      { id: 'fileB', fileName: 'B.pdf', tags: [] },
    ];
    const forward = await run(makeCtx({ files, rows: () => [...rows] }), 'indexed');
    const reversed = await run(makeCtx({ files, rows: () => [...rows].reverse() }), 'indexed');
    expect(reversed.content).toBe(forward.content);
    const ids = (q: typeof forward.quest) =>
      ((q.promptMeta as { citables?: { id: string }[] }).citables ?? []).map(c => c.id);
    expect(ids(reversed.quest)).toEqual(ids(forward.quest));
  });

  it('a saturated batch is reported rather than silently dropping the rest of its chunks', async () => {
    // A full page means more chunks existed than one read returns.
    const ctx = makeCtx({
      rows: () =>
        Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, fabFileId: 'fileA', text: 'x', vector: [1, 0] })),
    });
    const { content } = await run(ctx);
    expect(content).toContain('Coverage note');
    expect((ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.stringContaining('more chunks than one read returns')
    );
  });

  it('the per-turn chunk budget stops the scan instead of reading every batch', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      id: `f${String(i).padStart(3, '0')}`,
      fileName: `F${String(i).padStart(3, '0')}.pdf`,
      tags: [],
    }));
    const ctx = makeCtx({
      files,
      rows: ids =>
        ids.flatMap(id =>
          Array.from({ length: 100 }, (_, i) => ({ id: `${id}-${i}`, fabFileId: id, text: 'x', vector: [1, 0] }))
        ),
    });
    await run(ctx);
    // 4000-chunk budget over 1000-chunk batches: far fewer than the 10 batches 100 files imply.
    expect(ctx.db.fabfilechunks.findVectorsByFabFileIds.mock.calls.length).toBeLessThanOrEqual(5);
    expect((ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.stringContaining('scan budget')
    );
  });

  it('grounds nothing when the projected reader is missing, rather than falling back', async () => {
    const ctx = makeCtx({});
    (ctx.db.fabfilechunks as { findVectorsByFabFileIds?: unknown }).findVectorsByFabFileIds = undefined;
    const { messages } = await run(ctx);
    expect(messages).toEqual([]);
    expect(ctx.db.fabfilechunks.findByFabFileId).not.toHaveBeenCalled();
  });

  it('warns when candidate documents declare more than one embedding model', async () => {
    const ctx = makeCtx({
      files: [
        { id: 'fileA', fileName: 'A.pdf', tags: [], embeddingModel: 'text-embedding-ada-002' },
        { id: 'fileB', fileName: 'B.pdf', tags: [], embeddingModel: 'voyage-3' },
      ],
    });
    await run(ctx);
    expect((ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.stringContaining('different embedding models')
    );
  });

  it('truncates the last chunk at the char budget without spilling over', async () => {
    const ctx = makeCtx({
      rows: () => [{ id: 'c1', fabFileId: 'fileA', text: 'z'.repeat(20000), vector: [1, 0] }],
    });
    const { content } = await run(ctx);
    expect((content.match(/z/g) ?? []).length).toBe(12000);
  });
});

/**
 * Server-path regression lock: the client-facing redaction of `systemPromptText` happens
 * only at the response boundary (on copies). The completion engine still consumes the
 * prompt off the DB-sourced session via this feature; verify it is injected verbatim.
 */
describe('SessionPromptFeature (#9405 — engine still consumes systemPromptText)', () => {
  const makeCtx = () =>
    ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger }) as unknown as Parameters<
      typeof SessionPromptFeature.prototype.constructor
    >[0];

  it('injects the session systemPromptText verbatim as a system message', async () => {
    const feature = new SessionPromptFeature(makeCtx(), 'PROPRIETARY SERVER-OWNED PROMPT');
    const messages = await feature.getContextMessages();
    expect(messages).toEqual([{ role: 'system', content: 'PROPRIETARY SERVER-OWNED PROMPT' }]);
  });

  it('returns no system message when the prompt is absent (unaffected by redaction)', async () => {
    expect(await new SessionPromptFeature(makeCtx(), undefined).getContextMessages()).toEqual([]);
    expect(await new SessionPromptFeature(makeCtx(), '   ').getContextMessages()).toEqual([]);
  });
});
