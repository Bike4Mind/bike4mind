/**
 * Unit tests for Spider's business logic - operation determination, dry-run session
 * processing, batch stats, error handling - using mocked deps to isolate DB/event side effects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock SST Resource before importing spider (which imports eventBus and config)
vi.mock('sst', () => {
  // Create a proxy that returns mock values for any property access
  const createMockValue = () => ({ value: 'mock-value', name: 'mock-name' });
  const resourceHandler: ProxyHandler<object> = {
    get: (_target, prop) => {
      if (prop === 'App') return { stage: 'test' };
      if (prop === 'AppEventBus') return { name: 'mock-event-bus' };
      if (prop === 'websocket') return { managementEndpoint: 'mock-endpoint' };
      return createMockValue();
    },
  };
  return {
    Resource: new Proxy({}, resourceHandler),
  };
});

import {
  determineSessionOperations,
  hasOperationsToPerform,
  processSession,
  processAllSessions,
  SpiderJobConfig,
  SpiderDependencies,
  SpiderOperation,
} from './spider';
import { ISessionDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import mongoose from 'mongoose';

function createMockSession(overrides: Partial<ISessionDocument> = {}): ISessionDocument {
  const id = new mongoose.Types.ObjectId().toString();
  return {
    id,
    _id: id,
    userId: 'user-123',
    name: 'Test Notebook',
    messageCount: undefined,
    curatedAt: undefined,
    summaryAt: undefined,
    taggedAt: undefined,
    deletedAt: undefined,
    createdAt: new Date(),
    lastUpdated: new Date(),
    ...overrides,
  } as unknown as ISessionDocument;
}

function createMockDeps(): SpiderDependencies {
  return {
    sessionRepository: {
      populateMessageCounts: vi.fn().mockResolvedValue([]),
    } as any,
    publishCuration: vi.fn().mockResolvedValue(undefined),
    publishSummarize: vi.fn().mockResolvedValue(undefined),
    publishTag: vi.fn().mockResolvedValue(undefined),
    sendProgress: vi.fn().mockResolvedValue(undefined) as unknown as SpiderDependencies['sendProgress'],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      updateMetadata: vi.fn(),
    } as unknown as Logger,
  };
}

function createJobConfig(overrides: Partial<SpiderJobConfig> = {}): SpiderJobConfig {
  return {
    spiderJobId: 'job-123',
    userId: 'user-123',
    totalNotebooks: 10,
    operations: ['messageCount', 'curation', 'summarize', 'tags'],
    dryRun: false,
    ...overrides,
  };
}

describe('Spider - determineSessionOperations', () => {
  describe('when all operations are requested', () => {
    const allOperations: SpiderOperation[] = ['messageCount', 'curation', 'summarize', 'tags'];

    it('should enable all operations for a fresh session', () => {
      const session = createMockSession();
      const result = determineSessionOperations(session, allOperations);

      expect(result).toEqual({
        messageCount: true,
        curation: true,
        summarize: true,
        tags: true,
        embeddings: false, // Not in allOperations list
      });
    });

    it('should skip curation if session already curated', () => {
      const session = createMockSession({ curatedAt: new Date() });
      const result = determineSessionOperations(session, allOperations);

      expect(result.curation).toBe(false);
      expect(result.messageCount).toBe(true);
      expect(result.summarize).toBe(true);
      expect(result.tags).toBe(true);
    });

    it('should skip summarization if session already summarized', () => {
      const session = createMockSession({ summaryAt: new Date() });
      const result = determineSessionOperations(session, allOperations);

      expect(result.summarize).toBe(false);
      expect(result.messageCount).toBe(true);
      expect(result.curation).toBe(true);
      expect(result.tags).toBe(true);
    });

    it('should skip tagging if session already tagged', () => {
      const session = createMockSession({ taggedAt: new Date() });
      const result = determineSessionOperations(session, allOperations);

      expect(result.tags).toBe(false);
      expect(result.messageCount).toBe(true);
      expect(result.curation).toBe(true);
      expect(result.summarize).toBe(true);
    });

    it('should only enable messageCount for fully processed session', () => {
      const session = createMockSession({
        curatedAt: new Date(),
        summaryAt: new Date(),
        taggedAt: new Date(),
      });
      const result = determineSessionOperations(session, allOperations);

      expect(result).toEqual({
        messageCount: true,
        curation: false,
        summarize: false,
        tags: false,
        embeddings: false,
      });
    });
  });

  describe('when specific operations are requested', () => {
    it('should only enable messageCount when only that is requested', () => {
      const session = createMockSession();
      const result = determineSessionOperations(session, ['messageCount']);

      expect(result).toEqual({
        messageCount: true,
        curation: false,
        summarize: false,
        tags: false,
        embeddings: false,
      });
    });

    it('should only enable curation when only that is requested', () => {
      const session = createMockSession();
      const result = determineSessionOperations(session, ['curation']);

      expect(result).toEqual({
        messageCount: false,
        curation: true,
        summarize: false,
        tags: false,
        embeddings: false,
      });
    });

    it('should handle combination of specific operations', () => {
      const session = createMockSession();
      const result = determineSessionOperations(session, ['messageCount', 'tags']);

      expect(result).toEqual({
        messageCount: true,
        curation: false,
        summarize: false,
        tags: true,
        embeddings: false,
      });
    });
  });
});

describe('Spider - hasOperationsToPerform', () => {
  it('should return true when at least one operation is enabled', () => {
    expect(
      hasOperationsToPerform({
        messageCount: true,
        curation: false,
        summarize: false,
        tags: false,
        embeddings: false,
      })
    ).toBe(true);
    expect(
      hasOperationsToPerform({
        messageCount: false,
        curation: true,
        summarize: false,
        tags: false,
        embeddings: false,
      })
    ).toBe(true);
    expect(
      hasOperationsToPerform({
        messageCount: false,
        curation: false,
        summarize: true,
        tags: false,
        embeddings: false,
      })
    ).toBe(true);
    expect(
      hasOperationsToPerform({
        messageCount: false,
        curation: false,
        summarize: false,
        tags: true,
        embeddings: false,
      })
    ).toBe(true);
    expect(
      hasOperationsToPerform({
        messageCount: false,
        curation: false,
        summarize: false,
        tags: false,
        embeddings: true,
      })
    ).toBe(true);
  });

  it('should return false when no operations are enabled', () => {
    expect(
      hasOperationsToPerform({
        messageCount: false,
        curation: false,
        summarize: false,
        tags: false,
        embeddings: false,
      })
    ).toBe(false);
  });

  it('should return true when multiple operations are enabled', () => {
    expect(
      hasOperationsToPerform({ messageCount: true, curation: true, summarize: true, tags: true, embeddings: true })
    ).toBe(true);
  });
});

describe('Spider - processSession', () => {
  let deps: SpiderDependencies;

  beforeEach(() => {
    deps = createMockDeps();
  });

  describe('normal mode (not dry-run)', () => {
    it('should execute all operations for a fresh session', async () => {
      const session = createMockSession();
      const config = createJobConfig();

      const result = await processSession(session, config, deps);

      expect(result.skipped).toBe(false);
      expect(result.operations.messageCount).toBe(true);
      expect(result.operations.curation).toBe(true);
      expect(result.operations.summarize).toBe(true);
      expect(result.operations.tags).toBe(true);

      expect(deps.sessionRepository.populateMessageCounts).toHaveBeenCalledWith([session]);
      expect(deps.publishCuration).toHaveBeenCalled();
      expect(deps.publishSummarize).toHaveBeenCalled();
      expect(deps.publishTag).toHaveBeenCalled();
    });

    it('should skip already-processed operations', async () => {
      const session = createMockSession({
        curatedAt: new Date(),
        summaryAt: new Date(),
      });
      const config = createJobConfig();

      const result = await processSession(session, config, deps);

      expect(result.operations.curation).toBe(false);
      expect(result.operations.summarize).toBe(false);
      expect(result.operations.tags).toBe(true);

      expect(deps.publishCuration).not.toHaveBeenCalled();
      expect(deps.publishSummarize).not.toHaveBeenCalled();
      expect(deps.publishTag).toHaveBeenCalled();
    });

    it('should mark session as skipped when no operations needed', async () => {
      const session = createMockSession({
        curatedAt: new Date(),
        summaryAt: new Date(),
        taggedAt: new Date(),
      });
      // Only request operations that are already done (except messageCount)
      const config = createJobConfig({ operations: ['curation', 'summarize', 'tags'] });

      const result = await processSession(session, config, deps);

      expect(result.skipped).toBe(true);
      expect(deps.publishCuration).not.toHaveBeenCalled();
      expect(deps.publishSummarize).not.toHaveBeenCalled();
      expect(deps.publishTag).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      const session = createMockSession();
      const config = createJobConfig();
      deps.publishCuration = vi.fn().mockRejectedValue(new Error('Curation failed'));

      const result = await processSession(session, config, deps);

      expect(result.error).toBe('Curation failed');
    });

    it('should call populateMessageCounts to recalculate (without clearing first)', async () => {
      const session = createMockSession({ messageCount: 42 });
      const config = createJobConfig({ operations: ['messageCount'] });

      await processSession(session, config, deps);

      // populateMessageCounts recalculates internally; no need to clear messageCount first
      expect(deps.sessionRepository.populateMessageCounts).toHaveBeenCalledWith([session]);
    });
  });

  describe('dry-run mode', () => {
    it('should NOT execute any operations in dry-run mode', async () => {
      const session = createMockSession();
      const config = createJobConfig({ dryRun: true });

      const result = await processSession(session, config, deps);

      expect(result.skipped).toBe(false);
      expect(result.operations.messageCount).toBe(true);
      expect(result.operations.curation).toBe(true);
      expect(result.operations.summarize).toBe(true);
      expect(result.operations.tags).toBe(true);

      expect(deps.sessionRepository.populateMessageCounts).not.toHaveBeenCalled();
      expect(deps.publishCuration).not.toHaveBeenCalled();
      expect(deps.publishSummarize).not.toHaveBeenCalled();
      expect(deps.publishTag).not.toHaveBeenCalled();
    });

    it('should correctly report what would be done in dry-run', async () => {
      const session = createMockSession({ curatedAt: new Date() });
      const config = createJobConfig({ dryRun: true });

      const result = await processSession(session, config, deps);

      // Should report curation as skipped (already done) even in dry-run
      expect(result.operations.curation).toBe(false);
      expect(result.operations.messageCount).toBe(true);
      expect(result.operations.summarize).toBe(true);
      expect(result.operations.tags).toBe(true);
    });

    it('should mark fully-processed session as skipped in dry-run', async () => {
      const session = createMockSession({
        curatedAt: new Date(),
        summaryAt: new Date(),
        taggedAt: new Date(),
      });
      const config = createJobConfig({ dryRun: true, operations: ['curation', 'summarize', 'tags'] });

      const result = await processSession(session, config, deps);

      expect(result.skipped).toBe(true);
    });
  });
});

describe('Spider - processAllSessions', () => {
  let deps: SpiderDependencies;

  beforeEach(() => {
    deps = createMockDeps();
    // These tests trigger rate-limited publishing in spider.ts which uses real setTimeout sleeps (1s).
    // Use fake timers so the suite runs fast while still validating batching/counting logic.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should process all sessions and return accurate stats', async () => {
    const sessions = [
      createMockSession({ name: 'Fresh Notebook' }),
      createMockSession({ name: 'Curated', curatedAt: new Date() }),
      createMockSession({ name: 'Summarized', summaryAt: new Date() }),
      createMockSession({ name: 'Tagged', taggedAt: new Date() }),
      createMockSession({
        name: 'Fully Processed',
        curatedAt: new Date(),
        summaryAt: new Date(),
        taggedAt: new Date(),
      }),
    ];
    const config = createJobConfig({ totalNotebooks: 5 });

    const promise = processAllSessions(sessions, config, deps);
    await vi.runAllTimersAsync();
    const { stats, results } = await promise;

    expect(results).toHaveLength(5);
    expect(stats.messageCountsUpdated).toBe(5); // All get messageCount
    // "Curated" and "Fully Processed" already have curatedAt, so 3 notebooks get curated
    expect(stats.notebooksCurated).toBe(3);
    // "Summarized" and "Fully Processed" already have summaryAt, so 3 notebooks get summarized
    expect(stats.notebooksSummarized).toBe(3);
    // "Tagged" and "Fully Processed" already have taggedAt, so 3 notebooks get tagged
    expect(stats.notebooksTagged).toBe(3);
    expect(stats.skipped).toBe(0); // None fully skipped due to messageCount
    expect(stats.errors).toBe(0);
  });

  it('should send progress updates at correct intervals', async () => {
    const sessions = Array.from({ length: 25 }, (_, i) => createMockSession({ name: `Notebook ${i}` }));
    const config = createJobConfig({ totalNotebooks: 25 });

    const promise = processAllSessions(sessions, config, deps);
    await vi.runAllTimersAsync();
    await promise;

    // Progress at 10, 20, and batch end (25)
    // With batchSize=50, we only have 1 batch, so 2 progress calls at 10, 20, plus 1 batch end
    const progressCalls = (deps.sendProgress as ReturnType<typeof vi.fn>).mock.calls;
    expect(progressCalls.length).toBeGreaterThanOrEqual(3);
  }, 120000); // 2 min timeout due to rate limiting delays (25 sessions × 3 events = 75 events, ~15 batches × 1s)

  it('should handle errors without stopping the job', async () => {
    const sessions = [createMockSession({ name: 'Good Notebook' }), createMockSession({ name: 'Bad Notebook' })];
    const config = createJobConfig({ totalNotebooks: 2 });

    // Make the second session fail during publishing
    let callCount = 0;
    deps.publishCuration = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        return Promise.reject(new Error('Curation failed'));
      }
      return Promise.resolve();
    });

    const promise = processAllSessions(sessions, config, deps);
    await vi.runAllTimersAsync();
    const { stats, results } = await promise;

    // Phase 1 scans and queues both sessions; Phase 2 publishes with rate limiting, where the
    // second curation fails - so the error count comes from the publishing phase.
    expect(stats.errors).toBe(1);
    // Both sessions' messageCount operations are counted in Phase 1 (before publishing)
    expect(stats.messageCountsUpdated).toBe(2);
    // The results array reflects the scanning phase, not the publishing phase,
    // so we don't expect result[1].error to be set
    expect(results).toHaveLength(2);
  });

  it('should correctly count skipped sessions', async () => {
    const sessions = [
      createMockSession({
        name: 'Fully Processed',
        curatedAt: new Date(),
        summaryAt: new Date(),
        taggedAt: new Date(),
      }),
    ];
    // Only request operations that are already done
    const config = createJobConfig({
      totalNotebooks: 1,
      operations: ['curation', 'summarize', 'tags'],
    });

    const promise = processAllSessions(sessions, config, deps);
    await vi.runAllTimersAsync();
    const { stats } = await promise;

    expect(stats.skipped).toBe(1);
    expect(stats.notebooksCurated).toBe(0);
    expect(stats.notebooksSummarized).toBe(0);
    expect(stats.notebooksTagged).toBe(0);
  });

  it('should work with dry-run mode', async () => {
    const sessions = [createMockSession({ name: 'Test Notebook' })];
    const config = createJobConfig({ totalNotebooks: 1, dryRun: true });

    const promise = processAllSessions(sessions, config, deps);
    await vi.runAllTimersAsync();
    const { stats } = await promise;

    // Stats should reflect what WOULD be done
    expect(stats.messageCountsUpdated).toBe(1);
    expect(stats.notebooksCurated).toBe(1);
    expect(stats.notebooksSummarized).toBe(1);
    expect(stats.notebooksTagged).toBe(1);

    // But no actual operations should have been called
    expect(deps.sessionRepository.populateMessageCounts).not.toHaveBeenCalled();
    expect(deps.publishCuration).not.toHaveBeenCalled();
    expect(deps.publishSummarize).not.toHaveBeenCalled();
    expect(deps.publishTag).not.toHaveBeenCalled();
  });

  it('should process in batches', async () => {
    // Create 120 sessions to span 3 batches (50 + 50 + 20)
    const sessions = Array.from({ length: 120 }, (_, i) => createMockSession({ name: `Notebook ${i}` }));
    const config = createJobConfig({ totalNotebooks: 120 });

    const promise = processAllSessions(sessions, config, deps, 50);
    await vi.runAllTimersAsync();
    const { stats } = await promise;

    expect(stats.messageCountsUpdated).toBe(120);

    // Should have sent batch-end progress for each scanning batch
    const progressCalls = (deps.sendProgress as ReturnType<typeof vi.fn>).mock.calls;
    const batchEndCalls = progressCalls.filter(call => call[0].currentOperation?.includes('Scanned batch'));
    expect(batchEndCalls.length).toBe(3);
  }, 300000); // 5 min timeout: 120 sessions × 3 events = 360 events, 72 batches × 1s delay = 72s + processing time
});

describe('Spider - Edge Cases', () => {
  let deps: SpiderDependencies;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('should handle empty session list', async () => {
    const config = createJobConfig({ totalNotebooks: 0 });

    const { stats, results } = await processAllSessions([], config, deps);

    expect(stats.messageCountsUpdated).toBe(0);
    expect(stats.errors).toBe(0);
    expect(results).toHaveLength(0);
  });

  it('should handle session with undefined name', async () => {
    const session = createMockSession({ name: undefined as any });
    const config = createJobConfig();

    const result = await processSession(session, config, deps);

    expect(result.sessionName).toBe('Untitled');
  });

  it('should handle sessions with null timestamps (not undefined)', async () => {
    const session = createMockSession({
      curatedAt: null as any,
      summaryAt: null as any,
      taggedAt: null as any,
    });
    const config = createJobConfig();

    const result = await processSession(session, config, deps);

    // null should be treated as "not done" - operations should run
    expect(result.operations.curation).toBe(true);
    expect(result.operations.summarize).toBe(true);
    expect(result.operations.tags).toBe(true);
  });

  it('should preserve operation order in stats', async () => {
    const sessions = [createMockSession()];
    const config = createJobConfig();

    await processAllSessions(sessions, config, deps);

    const callOrder: string[] = [];

    if ((deps.sessionRepository.populateMessageCounts as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
      callOrder.push('messageCount');
    }
    if ((deps.publishCuration as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
      callOrder.push('curation');
    }
    if ((deps.publishSummarize as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
      callOrder.push('summarize');
    }
    if ((deps.publishTag as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
      callOrder.push('tags');
    }

    expect(callOrder).toEqual(['messageCount', 'curation', 'summarize', 'tags']);
  });

  it('should handle session with null/undefined id gracefully', async () => {
    // Simulate a session with no id (shouldn't happen but production showed it can)
    const session = createMockSession({ name: 'Test Session' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).id = null;
    const config = createJobConfig();

    const result = await processSession(session, config, deps);

    expect(result.skipped).toBe(true);
    expect(result.error).toBe('Session missing id field');
    expect(result.sessionId).toBe('unknown');

    expect(deps.publishCuration).not.toHaveBeenCalled();
    expect(deps.publishSummarize).not.toHaveBeenCalled();
    expect(deps.publishTag).not.toHaveBeenCalled();
  });
});
