import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ContextSummarizationFeature,
  KnowledgeRetrievalFeature,
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
        { fabFileId: 'fileA', text: 'chunk A1', vector: [1, 0] },
        { fabFileId: 'fileA', text: 'chunk A2', vector: [0.95, 0.05] },
      ],
      fileB: [{ fabFileId: 'fileB', text: 'chunk B1', vector: [0.9, 0.1] }],
    };
    return {
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      user: { id: 'u1', tags: [], groups: [] },
      db: {
        fabfiles: { search: vi.fn().mockResolvedValue({ data: files }) },
        fabfilechunks: { findByFabFileId: vi.fn((id: string) => Promise.resolve(chunksByFile[id] ?? [])) },
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
      fileA: [{ fabFileId: 'fileA', text: 'chunk A1', vector: [1, 0] }],
      fileB: [{ fabFileId: 'fileB', text: 'chunk B1', vector: [0.9, 0.1] }],
    };
    return {
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      user: { id: 'u1', tags: [], groups: [] },
      db: {
        fabfiles: { search: vi.fn().mockResolvedValue({ data: files }) },
        fabfilechunks: { findByFabFileId: vi.fn((id: string) => Promise.resolve(chunksByFile[id] ?? [])) },
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
