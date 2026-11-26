import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sends: 0,
  dispatches: 0,
  settles: 0,
  unresolved: 0,
  completed: false,
  completedIds: [] as string[],
  emitUsage: false,
  failSettlement: false,
  accounting: undefined as unknown,
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    getSettingsValue: vi.fn().mockResolvedValue({
      repos: [
        {
          owner: 'acme',
          repo: 'app',
          enabled: true,
          modelId: 'test-model',
          patternLibrary: { enabled: false, minConfidence: 80 },
        },
      ],
    }),
  },
  apiKeyRepository: {},
  inboxRepository: {},
  sreErrorPatternRepository: {},
  cacheRepository: { deleteByKey: vi.fn() },
  sreErrorTrackingRepository: {
    claimForAnalysis: vi.fn().mockResolvedValue({ id: 'tracking' }),
    countConsecutiveFailures: vi.fn().mockResolvedValue(0),
    countFixesDispatchedToday: vi.fn().mockResolvedValue(0),
    hasRecentFixForFiles: vi.fn().mockResolvedValue(false),
    findMergedFixesForFingerprint: vi.fn().mockResolvedValue([]),
    findByPrNumber: vi.fn().mockResolvedValue({ revisionCount: 1 }),
    hasCompletedRevisionAccounting: vi.fn(async (_id, _repo, executionId) => state.completedIds.includes(executionId)),
    completeRevisionAccounting: vi.fn(async (_id, _repo, executionId) => {
      state.completed = true;
      state.completedIds.push(executionId);
    }),
    updateStatus: vi.fn(),
    atomicTransition: vi.fn(),
  },
}));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) } }));
vi.mock('@bike4mind/llm-adapters', () => ({
  resolveDeprecatedModelId: (id: string) => id,
  federatedSharedKeyProviders: () => undefined,
  getAvailableModels: vi.fn().mockResolvedValue([
    {
      id: 'test-model',
      backend: 'openai',
      name: 'Test',
      type: 'text',
      contextWindow: 100000,
      pricing: { 100000: { input: 1e-6, output: 2e-6 } },
      priceSource: 'catalog',
      priceRowId: 'test-price',
    },
  ]),
  getLlmByModel: () => ({
    complete: async (
      _model: unknown,
      _messages: unknown,
      _options: unknown,
      onText: (texts: string[], usage: object) => Promise<void>
    ) => {
      state.sends++;
      if (state.emitUsage) await onText([''], { inputTokens: 11, outputTokens: 3 });
      throw new Error('provider unavailable');
    },
  }),
}));
vi.mock(
  '@bike4mind/services/sreAgentService/tools',
  () => import('../../../../b4m-core/services/src/sreAgentService/tools')
);
vi.mock('@bike4mind/services/sreAgentService', () => import('../../../../b4m-core/services/src/sreAgentService'));
vi.mock('./sreQueueAccounting', async importOriginal => {
  const actual = await importOriginal<typeof import('./sreQueueAccounting')>();
  return { ...actual, createSreQueueAccounting: () => state.accounting };
});
vi.mock('@bike4mind/utils', () => ({
  getSettingsByNames: vi.fn().mockResolvedValue({}),
}));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  SreEvents: {
    AnalysisCompleted: {
      publish: vi.fn(async () => {
        state.dispatches++;
      }),
    },
  },
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  sendToQueue: vi.fn(async () => {
    state.dispatches++;
  }),
}));
vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({ dispatchWithLogger: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/services/githubService', () => ({
  GitHubService: {
    forSystem: vi.fn().mockResolvedValue({
      getFileContent: vi.fn(),
      searchCode: vi.fn(),
      listDirectoryContents: vi.fn(),
      listIssueComments: vi.fn().mockResolvedValue([]),
    }),
  },
  GitHubRateLimitError: class extends Error {},
}));
vi.mock('@bike4mind/server-utils/integrations/slack/sreSlackApproval', () => ({
  postSreApprovalMessage: vi.fn(),
  postSreScopeBlockedMessage: vi.fn(),
  postSreNoFixNeededMessage: vi.fn(),
  postSreFixLoopMessage: vi.fn(),
  postSreLowConfidenceMessage: vi.fn(),
  postSreRateLimitedMessage: vi.fn(),
  postSreAnalysisFailureMessage: vi.fn(),
  postSreRevisionStartedMessage: vi.fn(),
  postSreFixFailureMessage: vi.fn(),
}));
vi.mock('@workers/integrations/sre/escalation', () => ({ escalateRecurrence: vi.fn() }));
vi.mock('@workers/integrations/sre/wontFixComment', () => ({
  buildWontFixCommentBody: vi.fn(),
  WONT_FIX_COMMENT_MARKER: 'test-marker',
}));

import { dispatch } from './sreJob';
import { SreAccountingError } from '@bike4mind/services/sreAgentService';
import { SreSourceType, SreClassification } from '@bike4mind/common';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
} as never;
function event(jobType: 'analysis' | 'revision') {
  return {
    Records: [
      {
        body: JSON.stringify({
          jobType,
          repoSlug: 'acme/app',
          source: SreSourceType.GITHUB_ISSUE,
          classification: SreClassification.HIGH,
          fingerprint: 'test-fingerprint',
          errorMessage: 'test error',
          trackingId: 'tracking',
          prNumber: 42,
          branchName: 'test-branch',
          reviewBody: 'please revise',
          originalDiagnosis: {
            rootCause: 'test error',
            proposedFix: 'repair',
            confidence: 90,
            riskAssessment: 'low',
            affectedFiles: [],
          },
        }),
      },
    ],
  } as never;
}

describe('SRE real service accounting queue propagation', () => {
  beforeEach(() => {
    state.sends = state.dispatches = state.settles = state.unresolved = 0;
    state.completed = false;
    state.completedIds = [];
    state.emitUsage = state.failSettlement = false;
    const attempts = new Map<string, Record<string, unknown>>();
    state.accounting = {
      deadlineAt: Date.now() + 120000,
      attribution: {
        kind: 'platform_operation',
        operation: 'sre_diagnosis',
        environment: 'test',
        logicalJobId: 'test-job',
        executionId: 'test-execution',
      },
      accounting: {
        recover: vi.fn(async () => {
          let recorded = 0;
          for (const attempt of attempts.values())
            if (attempt.state === 'usage_known') {
              attempt.state = 'recorded';
              recorded++;
            }
          return { recorded, unresolved: 0, failed: [] };
        }),
        diagnostics: vi.fn(async () => {
          const pending = [...attempts.values()].filter(attempt => attempt.state !== 'recorded');
          return {
            attempts: pending,
            total: pending.length,
            byState: { registered: pending.filter(attempt => attempt.state === 'registered').length },
          };
        }),
        register: vi.fn(async input => {
          if (!attempts.has(input.providerCallId))
            attempts.set(input.providerCallId, { ...input, state: 'registered' });
          return attempts.get(input.providerCallId);
        }),
        claimDispatch: vi.fn(async providerCallId => {
          const attempt = attempts.get(providerCallId);
          if (attempt?.state !== 'registered') return false;
          attempt.state = 'dispatched';
          return true;
        }),
        settle: vi.fn(async providerCallId => {
          state.settles++;
          const attempt = attempts.get(providerCallId)!;
          attempt.state = state.failSettlement ? 'usage_known' : 'recorded';
          if (state.failSettlement) throw new Error('ledger unavailable');
        }),
        unresolved: vi.fn(async () => {
          state.unresolved++;
          throw new Error('journal unavailable');
        }),
      },
    };
  });

  it.each(['analysis', 'revision'] as const)(
    'rejects %s acknowledgment when actual service cannot record an outcome',
    async jobType => {
      await expect(
        dispatch(event(jobType), { getRemainingTimeInMillis: () => 120000 } as never, logger)
      ).rejects.toBeInstanceOf(SreAccountingError);
      expect(state.sends).toBe(1);
      expect(state.unresolved).toBe(1);
      expect(state.settles).toBe(0);
      expect(state.dispatches).toBe(0);
      expect(state.completed).toBe(false);
    }
  );
  it('acknowledges completed revision redelivery without another paid call or business dispatch', async () => {
    state.emitUsage = true;
    await dispatch(event('revision'), { getRemainingTimeInMillis: () => 120000 } as never, logger);
    expect(state.completed).toBe(true);
    expect(state.settles).toBe(1);
    expect(state.sends).toBe(1);
    await dispatch(event('revision'), { getRemainingTimeInMillis: () => 120000 } as never, logger);
    expect(state.sends).toBe(1);
    expect(state.settles).toBe(1);
    expect(state.dispatches).toBe(0);
  });

  it.each(['analysis', 'revision'] as const)(
    'recovers the original %s receipt after a lost completion without re-inference',
    async jobType => {
      state.emitUsage = state.failSettlement = true;
      await expect(
        dispatch(event(jobType), { getRemainingTimeInMillis: () => 120000 } as never, logger)
      ).rejects.toBeInstanceOf(SreAccountingError);
      expect(state.sends).toBe(1);
      state.failSettlement = false;
      await expect(
        dispatch(event(jobType), { getRemainingTimeInMillis: () => 120000 } as never, logger)
      ).rejects.toBeInstanceOf(SreAccountingError);
      expect(state.sends).toBe(1);
      expect(state.dispatches).toBe(0);
      expect(state.completed).toBe(false);
    }
  );

  it('retains an old completed revision marker after a newer revision completes', async () => {
    state.emitUsage = true;
    const context = state.accounting as { attribution: { executionId: string } };
    await dispatch(event('revision'), { getRemainingTimeInMillis: () => 120000 } as never, logger);
    context.attribution.executionId = 'newer-execution';
    await dispatch(event('revision'), { getRemainingTimeInMillis: () => 120000 } as never, logger);
    expect(state.sends).toBe(2);
    context.attribution.executionId = 'test-execution';
    await dispatch(event('revision'), { getRemainingTimeInMillis: () => 120000 } as never, logger);
    expect(state.sends).toBe(2);
    expect(state.dispatches).toBe(0);
  });
});
