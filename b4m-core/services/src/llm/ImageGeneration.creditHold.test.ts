import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ImageModels,
  ModelBackend,
  RUN_BUDGET_EXHAUSTED_ERROR_CODE,
  UnprocessableEntityError,
  usdToCredits,
  type CompletionRunAttribution,
  type ModelInfo,
} from '@bike4mind/common';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { getSettingsValue } from '@bike4mind/utils';
import { ImageGenerationService } from './ImageGeneration';
import { GeminiImageCostCalculator } from './imageCostCalculator/GeminiImageCostCalculator';
import { holdCredits, releaseCreditHold, settleCreditHold, type CreditHoldAdapters } from '../creditService';
import type { ImageCreditHolds } from './imageCreditHolds';
import { silentLogger } from '../__tests__/utils/testUtils';

const notFrozen = { findActiveForSubject: async () => null };

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(),
}));

vi.mock('../apiKeyService', async importOriginal => ({
  ...(await importOriginal<typeof import('../apiKeyService')>()),
  getEffectiveLLMApiKeys: vi.fn(async () => ({ gemini: 'gemini-key' })),
}));

const mockGeminiGenerate = vi.fn();
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    aiImageService: vi.fn(() => ({ generate: mockGeminiGenerate })),
    getSettingsMap: vi.fn().mockResolvedValue({}),
    getSettingsValue: vi.fn(),
    ClientMessageSender: vi.fn().mockImplementation(function () {
      return { sendToClient: vi.fn().mockResolvedValue(undefined) };
    }),
  };
});

vi.mock('./imageModerationGate', () => ({ moderateImageOrThrow: vi.fn(async () => undefined) }));
vi.mock('./questHeartbeat', async importOriginal => ({
  ...(await importOriginal<typeof import('./questHeartbeat')>()),
  startQuestHeartbeat: vi.fn().mockResolvedValue(() => undefined),
}));

const MODEL = ImageModels.GEMINI_2_5_FLASH_IMAGE;
const modelInfo = {
  id: MODEL,
  type: 'image',
  name: MODEL,
  backend: ModelBackend.Gemini,
  contextWindow: 10000,
  max_tokens: 10000,
  supportsImageVariation: false,
  pricing: { 1: { input: 0, output: 0 } },
} as unknown as ModelInfo;
const ONE_IMAGE_CREDITS = usdToCredits(new GeminiImageCostCalculator().getCost({ model: MODEL }));

/**
 * One user whose balance moves through a single atomic counter, like Mongo's $inc, and a hold port
 * built on the real holdCredits / settleCreditHold / releaseCreditHold.
 */
const makeWallet = (balance: number, userFields: Record<string, unknown> = {}) => {
  const state = { balance, ledger: [] as number[] };
  const users = {
    findById: vi.fn(async (id: string) => ({ id, currentCredits: state.balance, ...userFields })),
    incrementCredits: vi.fn(async (id: string, delta: number) => {
      state.balance += delta;
      return { id, currentCredits: state.balance };
    }),
  };
  const adapters = {
    users,
    organizations: { findById: vi.fn(async () => null) },
    creditTransactions: {},
    spendFreezes: { findActiveForSubject: vi.fn(async () => null) },
    newAccountSpendCap: {
      adminSettings: { findAll: async () => [], findBySettingNames: async () => [] },
      personalSpendSince: async () => [],
    },
    deductCredits: vi.fn(async ({ credits }: { credits: number }) => {
      state.ledger.push(credits);
    }),
  } as unknown as CreditHoldAdapters;
  const creditHolds: ImageCreditHolds = {
    hold: params => holdCredits(params, adapters),
    release: hold => releaseCreditHold(hold, adapters),
    settle: (hold, charged, entry, context) => settleCreditHold(hold, charged, entry, context, adapters),
  };
  return { state, users, creditHolds };
};

const makeService = (
  wallet: ReturnType<typeof makeWallet>,
  assertModelAdmission: ConstructorParameters<typeof ImageGenerationService>[0]['assertModelAdmission'] = async () => {}
) => {
  const quests = new Map<
    string,
    { id: string; sessionId: string; status?: string; type?: string; reply?: string; errorCode?: string }
  >();
  const startImageGenerationProcess = vi.fn(async () => undefined);
  const service = new ImageGenerationService({
    assertModelAdmission,
    startImageGenerationProcess,
    db: {
      spendFreezes: notFrozen,
      sessions: { findById: vi.fn(async (id: string) => ({ id })) },
      quests: {
        findById: vi.fn(async (id: string) => {
          if (!quests.has(id)) quests.set(id, { id, sessionId: 'session1' });
          return quests.get(id);
        }),
        update: vi.fn(async (patch: { id: string }) => Object.assign(quests.get(patch.id)!, patch)),
        updateMany: vi.fn(),
        getMostRecentChatHistory: vi.fn(async () => []),
      },
      users: wallet.users,
      organizations: { findById: vi.fn(async () => null) },
      fabFiles: { findAccessibleInIds: vi.fn(async () => []) },
      creditTransactions: { createTransaction: vi.fn(async () => ({})) },
    },
    creditHolds: wallet.creditHolds,
    logEvent: vi.fn().mockResolvedValue(undefined),
    abilityGetter: vi.fn().mockReturnValue({}),
    storage: {
      upload: vi.fn().mockResolvedValue('generated/output.png'),
      getSignedUrl: vi.fn().mockResolvedValue('data:image/png;base64,AAAA'),
    },
    fabFileStorage: { getSignedUrl: vi.fn() },
    saveGeneratedAsset: vi.fn(async () => undefined),
    wsHttpsUrl: 'https://ws.example.com',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a partial db fake for the billing path only
  } as any);
  const run = (questId: string, adminRoleWithheld?: boolean, completionRun?: CompletionRunAttribution) =>
    service.process({
      body: {
        sessionId: 'session1',
        questId,
        userId: 'user1',
        prompt: 'a red bicycle',
        model: MODEL,
        adminRoleWithheld,
        run: completionRun,
      },
      logger: silentLogger,
    });
  return { service, run, quests, startImageGenerationProcess };
};

describe('ImageGenerationService credit hold', () => {
  beforeEach(() => {
    vi.mocked(getAvailableModels).mockResolvedValue([modelInfo]);
    vi.mocked(getSettingsValue).mockImplementation(((name: string) => name === 'enforceCredits' || undefined) as never);
    mockGeminiGenerate.mockReset();
    // Slow enough that every concurrent run reaches the provider before the first one settles.
    mockGeminiGenerate.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(['data:image/png;base64,AAAA']), 20))
    );
  });

  it('refuses a queued paid-only image before the credit hold or provider call', async () => {
    const wallet = makeWallet(10_000);
    const assertAdmission = vi.fn(async () => {
      throw new Error('paid plan required');
    });
    const { run } = makeService(wallet, assertAdmission);
    await run('paid-only', true);
    expect(assertAdmission).toHaveBeenCalledWith(expect.objectContaining({ id: 'user1' }), MODEL, true, undefined);
    expect(wallet.state.balance).toBe(10_000);
    expect(wallet.users.incrementCredits).not.toHaveBeenCalled();
    expect(mockGeminiGenerate).not.toHaveBeenCalled();
  });

  it('refuses a paid-only image before enqueueing and gates the selected model', async () => {
    const refusal = new Error('paid plan required');
    const assertAdmission = vi.fn(async () => {
      throw refusal;
    });
    const { service } = makeService(makeWallet(10_000), assertAdmission);
    await expect(
      service.invoke({
        userId: 'user1',
        adminRoleWithheld: true,
        body: {
          sessionId: 'session1',
          questId: 'quest1',
          prompt: 'image',
          model: ImageModels.GPT_IMAGE_2,
        },
      })
    ).rejects.toBe(refusal);
    expect(assertAdmission).toHaveBeenCalledWith('user1', ImageModels.GPT_IMAGE_2, true, undefined);
  });

  it('lets only as many concurrent generations through as the balance covers', async () => {
    const wallet = makeWallet(ONE_IMAGE_CREDITS);
    const { run, quests } = makeService(wallet);

    await Promise.all(['q1', 'q2', 'q3', 'q4'].map(questId => run(questId)));

    const outcomes = [...quests.values()];
    expect(outcomes.filter(q => q.status === 'done' && !q.errorCode)).toHaveLength(1);
    expect(outcomes.filter(q => q.errorCode === 'insufficient_credits')).toHaveLength(3);
    expect(mockGeminiGenerate).toHaveBeenCalledTimes(1);
    expect(wallet.state.balance).toBeGreaterThanOrEqual(0);
    expect(wallet.state.balance + wallet.state.ledger.reduce((a, b) => a + b, 0)).toBe(ONE_IMAGE_CREDITS);
  });

  it('moves no credits and calls no provider when the account is blocked by the time the hold is placed', async () => {
    // Admission is stubbed to pass, so the hold's own account check is the gate under test.
    const wallet = makeWallet(ONE_IMAGE_CREDITS * 2, { isBanned: true });
    const { run } = makeService(wallet);

    await run('q1');

    expect(wallet.users.incrementCredits).not.toHaveBeenCalled();
    expect(wallet.state.balance).toBe(ONE_IMAGE_CREDITS * 2);
    expect(wallet.state.ledger).toEqual([]);
    expect(mockGeminiGenerate).not.toHaveBeenCalled();
  });

  it('refunds the whole hold when the provider fails', async () => {
    const wallet = makeWallet(ONE_IMAGE_CREDITS * 2);
    const { run, quests } = makeService(wallet);
    mockGeminiGenerate.mockRejectedValueOnce(new Error('provider down'));

    await run('q1');

    expect(quests.get('q1')?.status).toBe('done');
    expect(quests.get('q1')?.errorCode).not.toBe('insufficient_credits');
    expect(wallet.state.balance).toBe(ONE_IMAGE_CREDITS * 2);
    expect(wallet.state.ledger).toEqual([]);
  });

  describe('on a redelivered message', () => {
    const deliver = (service: ImageGenerationService) =>
      service.process({
        body: {
          sessionId: 'session1',
          questId: 'q1',
          userId: 'user1',
          prompt: 'a red bicycle',
          model: MODEL,
          generationId: 'generation-1',
        },
        logger: silentLogger,
      });

    it('keys the hold on the generation id', async () => {
      const wallet = makeWallet(ONE_IMAGE_CREDITS * 2);
      const hold = vi.spyOn(wallet.creditHolds, 'hold');
      const { service } = makeService(wallet);

      await deliver(service);

      expect(hold).toHaveBeenCalledWith(expect.objectContaining({ holdKey: 'image_generation:generation-1' }));
    });

    it('leaves a reused hold for its first delivery when the render fails', async () => {
      const wallet = makeWallet(ONE_IMAGE_CREDITS * 2);
      const firstDeliveryHold = wallet.creditHolds.hold;
      vi.spyOn(wallet.creditHolds, 'hold').mockImplementationOnce(async params => ({
        ...(await firstDeliveryHold(params)),
        reused: true,
      }));
      const release = vi.spyOn(wallet.creditHolds, 'release');
      const { service } = makeService(wallet);
      mockGeminiGenerate.mockRejectedValueOnce(new Error('provider down'));

      await deliver(service);

      expect(release).not.toHaveBeenCalled();
    });

    it('still settles a reused hold when the render succeeds', async () => {
      const wallet = makeWallet(ONE_IMAGE_CREDITS * 2);
      const firstDeliveryHold = wallet.creditHolds.hold;
      vi.spyOn(wallet.creditHolds, 'hold').mockImplementationOnce(async params => ({
        ...(await firstDeliveryHold(params)),
        reused: true,
      }));
      const settle = vi.spyOn(wallet.creditHolds, 'settle');
      const { service } = makeService(wallet);

      await deliver(service);

      expect(settle).toHaveBeenCalledOnce();
    });
  });

  describe('with a completion run', () => {
    const completionRun: CompletionRunAttribution = {
      runId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
      role: 'worker',
      purpose: 'tool',
    };

    it('claims the run with the hold and tags the settled ledger entry with it', async () => {
      const wallet = makeWallet(ONE_IMAGE_CREDITS * 2);
      const hold = vi.spyOn(wallet.creditHolds, 'hold');
      const settle = vi.spyOn(wallet.creditHolds, 'settle');
      const { run } = makeService(wallet);

      await run('q1', undefined, completionRun);

      expect(hold).toHaveBeenCalledWith(expect.objectContaining({ run: completionRun }));
      expect(settle).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Number),
        expect.objectContaining({ type: 'image_generation_usage', run: completionRun }),
        expect.anything()
      );
    });

    it('fails the quest with run_budget_exhausted when the run cannot fit the hold', async () => {
      const wallet = makeWallet(ONE_IMAGE_CREDITS * 2);
      vi.spyOn(wallet.creditHolds, 'hold').mockRejectedValueOnce(
        new UnprocessableEntityError("This run's credit budget is used up", {
          errorCode: RUN_BUDGET_EXHAUSTED_ERROR_CODE,
        })
      );
      const { run, quests } = makeService(wallet);

      await run('q1', undefined, completionRun);

      expect(quests.get('q1')).toEqual(
        expect.objectContaining({
          status: 'done',
          type: 'error',
          errorCode: 'run_budget_exhausted',
          reply: "This run's credit budget is used up",
        })
      );
      expect(mockGeminiGenerate).not.toHaveBeenCalled();
      expect(wallet.state.balance).toBe(ONE_IMAGE_CREDITS * 2);
    });

    it('sends no run to the hold or the ledger without one', async () => {
      const wallet = makeWallet(ONE_IMAGE_CREDITS * 2);
      const hold = vi.spyOn(wallet.creditHolds, 'hold');
      const settle = vi.spyOn(wallet.creditHolds, 'settle');
      const { run } = makeService(wallet);

      await run('q1');

      expect(hold.mock.calls[0][0]).not.toHaveProperty('run');
      expect(settle.mock.calls[0][2]).not.toHaveProperty('run');
    });

    const invokeWith = (service: ImageGenerationService, assertHeadroom: (credits: number) => Promise<void>) =>
      service.invoke({
        userId: 'user1',
        body: { sessionId: 'session1', questId: 'q1', prompt: 'a red bicycle', model: MODEL },
        run: { attribution: completionRun, assertHeadroom },
      });

    it('checks the run has room for the render before queueing it with the run', async () => {
      const assertHeadroom = vi.fn(async () => undefined);
      const { service, startImageGenerationProcess } = makeService(makeWallet(0));

      await invokeWith(service, assertHeadroom);

      expect(assertHeadroom).toHaveBeenCalledWith(ONE_IMAGE_CREDITS);
      expect(startImageGenerationProcess).toHaveBeenCalledWith(expect.objectContaining({ run: completionRun }));
    });

    it('refuses before touching the quest or the queue when the run has no room', async () => {
      const refusal = new UnprocessableEntityError('used up', { errorCode: RUN_BUDGET_EXHAUSTED_ERROR_CODE });
      const { service, startImageGenerationProcess, quests } = makeService(makeWallet(0));

      await expect(invokeWith(service, async () => Promise.reject(refusal))).rejects.toBe(refusal);

      expect(quests.size).toBe(0);
      expect(startImageGenerationProcess).not.toHaveBeenCalled();
    });

    it('skips the headroom check when credits are not enforced', async () => {
      vi.mocked(getSettingsValue).mockReturnValue(undefined as never);
      const assertHeadroom = vi.fn(async () => undefined);
      const { service, startImageGenerationProcess } = makeService(makeWallet(0));

      await invokeWith(service, assertHeadroom);

      expect(assertHeadroom).not.toHaveBeenCalled();
      expect(startImageGenerationProcess).toHaveBeenCalledWith(expect.objectContaining({ run: completionRun }));
    });
  });
});
