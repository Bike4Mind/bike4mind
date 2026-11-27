import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatModels,
  CreditHolderType,
  ModelBackend,
  type IUsageEventInput,
  type IUserDocument,
  type ModelInfo,
} from '@bike4mind/common';
import { LlmTimeoutError, SafetyRefusalError, type ICompletionBackend } from '@bike4mind/llm-adapters';

const h = vi.hoisted(() => ({
  getEffectiveLLMApiKeys: vi.fn(),
  getAvailableModels: vi.fn(),
  getLlmByModel: vi.fn(),
  complete: vi.fn<ICompletionBackend['complete']>(),
  findOrganization: vi.fn(),
  recordUsage: vi.fn<(event: IUsageEventInput) => Promise<null>>(),
}));

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, { get: () => new Proxy({}, { get: () => 'mock' }) }),
}));
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/database/zero-credit-operational-usage', () => ({
  createBoundedZeroCreditOperationalUsageStore: () => ({
    findOrganizationById: h.findOrganization,
    usageEvents: { record: h.recordUsage },
  }),
}));
vi.mock('@bike4mind/utils', () => ({ secureParameters: vi.fn(), getSettingsByNames: vi.fn() }));
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  apiKeyService: { getEffectiveLLMApiKeys: h.getEffectiveLLMApiKeys },
}));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: h.getAvailableModels,
  getLlmByModel: h.getLlmByModel,
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ S3Storage: class {} }));
vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({ dispatchWithLogger: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: vi.fn(),
  getGeneratedImageStorage: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/sessionAccess', () => ({ filterReadableQuests: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/generatedImageAccess', () => ({ userCanAccessGeneratedImage: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/appFileProxy', () => ({ generatedKeyFromProxyPath: vi.fn() }));
vi.mock('@workers/queueHandlers/orgFeedbackSummary', async () => {
  const { z } = await import('zod');
  return {
    OrgFeedbackSummaryPayload: z.object({ jobType: z.literal('orgFeedbackSummary') }),
    runOrgFeedbackSummary: vi.fn(),
  };
});
vi.mock('./createZipBuffer', () => ({ createZipBuffer: vi.fn() }));

import { generateSummary } from './questExport';

const model: ModelInfo = {
  id: ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
  name: 'Test model',
  type: 'text',
  backend: ModelBackend.Bedrock,
  contextWindow: 100_000,
  max_tokens: 4096,
  pricing: { 100000: { input: 1e-6, output: 2e-6, cache_read: 0.1e-6, cache_write: 1.25e-6 } },
  priceSource: 'catalog',
  priceRowId: 'fixture-rate',
};

const usage = { inputTokens: 600, outputTokens: 80, cacheReadInputTokens: 100, stopReason: 'end_turn' };
const requester = { id: 'requester-1' } as IUserDocument;
const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the helper takes the real Logger
const run = (user = requester, logger = makeLogger()) => generateSummary('# Plan', 'Ship it', logger as any, user);

beforeEach(() => {
  vi.clearAllMocks();
  h.getEffectiveLLMApiKeys.mockResolvedValue({});
  h.getAvailableModels.mockResolvedValue([model]);
  h.getLlmByModel.mockReturnValue({ complete: h.complete });
  h.recordUsage.mockResolvedValue(null);
  h.complete.mockImplementation(async (_model, _messages, _options, onText) => {
    await onText(['An executive summary.'], usage);
  });
});

afterEach(() => vi.useRealTimers());

describe('quest export summary usage', () => {
  it("records the platform-key call as the requester's usage without a credit debit", async () => {
    await expect(run()).resolves.toBe('An executive summary.');

    expect(h.recordUsage).toHaveBeenCalledOnce();
    const [[row]] = h.recordUsage.mock.calls;
    expect(row).toMatchObject({
      feature: 'operations',
      source: 'system',
      userId: 'requester-1',
      ownerId: 'requester-1',
      ownerType: CreditHolderType.User,
      provider: 'bedrock',
      model: model.id,
      inputTokens: 600,
      outputTokens: 80,
      cachedInputTokens: 100,
      creditsCharged: 0,
      priceRowId: 'fixture-rate',
      requestMeta: { stopReason: 'end_turn' },
    });
    expect(row.costUsd).toBeCloseTo((600 * 1 + 80 * 2 + 100 * 0.1) / 1_000_000, 12);
    expect(JSON.stringify(row)).not.toMatch(/executive summary|Ship it|# Plan/);
  });

  it("attributes an org member's usage to the organization", async () => {
    h.findOrganization.mockResolvedValue({ id: 'org-1' });

    await run({ id: 'requester-1', organizationId: 'org-1' } as IUserDocument);

    expect(h.findOrganization).toHaveBeenCalledExactlyOnceWith('org-1');
    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: 'requester-1', ownerId: 'org-1', ownerType: CreditHolderType.Organization })
    );
  });

  it('skips the row rather than booking it personally when the organization is missing', async () => {
    h.findOrganization.mockResolvedValue(null);

    await expect(run({ id: 'requester-1', organizationId: 'org-1' } as IUserDocument)).resolves.toBe(
      'An executive summary.'
    );

    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('does not look up an organization for a requester without one', async () => {
    await run();

    expect(h.findOrganization).not.toHaveBeenCalled();
    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ownerId: 'requester-1', ownerType: CreditHolderType.User })
    );
  });

  it('records usage carried by a safety refusal without marking it a timeout', async () => {
    h.complete.mockRejectedValueOnce(new SafetyRefusalError(model.id, { inputTokens: 300, outputTokens: 5 }));

    await expect(run()).resolves.toBeNull();

    const [[row]] = h.recordUsage.mock.calls;
    expect(row).toMatchObject({ inputTokens: 300, outputTokens: 5, requestMeta: { stopReason: 'refusal' } });
    expect(row.status).not.toBe('timeout');
  });

  it('records reported usage when the provider fails, and the export still gets no summary', async () => {
    h.complete.mockImplementationOnce(async (_model, _messages, _options, onText) => {
      await onText(['partial'], usage);
      throw new Error('stream reset');
    });

    await expect(run()).resolves.toBeNull();

    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 600 }));
  });

  it('cancels the call at the deadline and records its usage as a timed-out attempt', async () => {
    vi.useFakeTimers();
    const inFlight = Promise.withResolvers<void>();
    h.complete.mockImplementationOnce(async (_model, _messages, _options, onText) => {
      await inFlight.promise;
      await onText(['late'], usage);
    });

    const pending = run();
    await vi.advanceTimersByTimeAsync(60_000);
    const [, , options] = h.complete.mock.calls[0];
    expect(options).toMatchObject({ stream: false, retryMode: 'abort-aware', maxTokens: 2000 });
    expect(options.abortSignal?.aborted).toBe(true);

    inFlight.resolve();
    await expect(pending).resolves.toBeNull();
    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        providerInputTokens: 600,
        providerOutputTokens: 80,
        settledBasis: 'provider',
        status: 'timeout',
        creditsCharged: 0,
      })
    );
  });

  it('prices usage carried by a provider timeout error', async () => {
    h.complete.mockRejectedValueOnce(
      new LlmTimeoutError('request', 1000, 'provider timeout', { usage: { inputTokens: 300, outputTokens: 5 } })
    );

    await expect(run()).resolves.toBeNull();

    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerInputTokens: 300, providerOutputTokens: 5, status: 'timeout' })
    );
  });

  it('does not fabricate a row when the provider reports no usage', async () => {
    h.complete.mockImplementationOnce(async (_model, _messages, _options, onText) => {
      await onText(['An executive summary.']);
    });

    await expect(run()).resolves.toBe('An executive summary.');

    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('keeps the summary when the usage write fails', async () => {
    h.recordUsage.mockRejectedValueOnce(new Error('insert failed'));

    await expect(run()).resolves.toBe('An executive summary.');
  });
});
