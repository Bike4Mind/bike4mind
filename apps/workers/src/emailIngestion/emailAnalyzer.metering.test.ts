import type { Handler, Context, SQSEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatModels, CreditHolderType, ModelBackend, type IUsageEventInput, type ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { dispatch } from './emailAnalyzer';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  findEmail: vi.fn(),
  findUser: vi.fn(),
  findOrganization: vi.fn(),
  updateEmail: vi.fn(),
  existsForEmail: vi.fn(),
  storeTriage: vi.fn(),
  record: vi.fn<(event: IUsageEventInput) => Promise<null>>(),
  complete: vi.fn<ICompletionBackend['complete']>(),
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() },
}));

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger:
    (handler: (event: SQSEvent, context: Context, logger: unknown) => Promise<void>) =>
    (event: SQSEvent, context: Context) =>
      handler(event, context, mocks.logger),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: async (name: string) => mocks.settings[name] },
  apiKeyRepository: {},
  ingestedEmailRepository: { findById: mocks.findEmail, update: mocks.updateEmail },
  User: { findById: mocks.findUser },
  organizationRepository: { findById: mocks.findOrganization },
  IngestedEmailModel: { countDocuments: async () => 0 },
  emailTriageItemRepository: { existsForEmail: mocks.existsForEmail, storeForLiveEmail: mocks.storeTriage },
  assistantBriefRepository: { removeEmailSourcedItems: vi.fn() },
  usageEventRepository: { record: mocks.record },
}));

vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({ anthropic: 'test' }) },
}));

vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: async () => [model],
  getLlmByModel: () => ({ complete: mocks.complete }),
}));

const model: ModelInfo = {
  id: ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
  name: 'Test model',
  type: 'text',
  backend: ModelBackend.BEDROCK_ANTHROPIC,
  contextWindow: 100_000,
  max_tokens: 4096,
  pricing: {
    100: { input: 1e-6, output: 2e-6, cache_read: 0.1e-6, cache_write: 1.25e-6 },
    100000: { input: 3e-6, output: 5e-6, cache_read: 0.3e-6, cache_write: 3.75e-6 },
  },
  priceSource: 'catalog',
  priceRowId: 'test-price-row',
};

const email = {
  userId: 'owner-1',
  from: 'sender@example.com',
  to: ['owner@example.com'],
  subject: 'Example subject',
  bodyText: 'Example body',
  date: new Date('2026-11-17T00:00:00Z'),
};

const analysisReply = JSON.stringify({
  summary: 'Review request',
  entities: { companies: [], people: [], products: [], technologies: [] },
  sentiment: 'neutral',
  actionItems: [],
  privacyRecommendation: 'private',
  embargoDetected: false,
  suggestedTags: ['review'],
});

const triageReply = JSON.stringify({ kind: 'decision', summary: 'Review request' });

const aggregateUsage = {
  inputTokens: 60,
  outputTokens: 10,
  cacheReadInputTokens: 35,
  cacheCreationInputTokens: 20,
  cacheWrite1hInputTokens: 5,
  stopReason: 'end_turn',
};

const run = () =>
  (dispatch as Handler<SQSEvent, void>)(
    { Records: [{ body: JSON.stringify({ emailId: 'email-1' }) }] } as SQSEvent,
    {} as Context,
    vi.fn()
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings = { EnableEmailAnalysis: true, EnableEmailTriage: true, EmailAnalysisModel: model.id };
  mocks.findEmail.mockResolvedValue(email);
  mocks.findUser.mockResolvedValue({ id: 'owner-1' });
  mocks.findOrganization.mockResolvedValue({ id: 'org-1' });
  mocks.existsForEmail.mockResolvedValue(false);
  mocks.storeTriage.mockResolvedValue({ status: 'created' });
  mocks.record.mockResolvedValue(null);
  mocks.complete.mockImplementation(async (_model, _messages, options, callback) => {
    await callback([options.maxTokens === 2000 ? analysisReply : triageReply], aggregateUsage);
  });
});

describe('email analyzer operational usage', () => {
  it('records analysis and triage separately with the actual owner and provider pricing', async () => {
    const turns = [
      { inputTokens: 50, outputTokens: 20, cacheReadInputTokens: 10, cacheCreationInputTokens: 10 },
      {
        inputTokens: 90,
        outputTokens: 15,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 15,
        cacheWrite1hInputTokens: 4,
      },
    ];
    mocks.complete.mockImplementationOnce(async (_model, _messages, _options, callback) => {
      await callback([analysisReply], aggregateUsage);
      await callback([], { turnUsage: turns, stopReason: 'end_turn' });
    });
    await run();

    expect(mocks.complete.mock.calls.map(([, , options]) => options)).toEqual([
      { maxTokens: 2000, stream: false, temperature: 0.3 },
      { maxTokens: 1200, temperature: 0.3 },
    ]);
    expect(mocks.record).toHaveBeenCalledTimes(2);
    const [[analysis], [triage]] = mocks.record.mock.calls;
    const attribution = {
      source: 'system',
      feature: 'operations',
      userId: 'owner-1',
      ownerId: 'owner-1',
      provider: model.backend,
      model: model.id,
      creditsCharged: 0,
      priceSource: 'catalog',
      priceRowId: 'test-price-row',
      requestMeta: { stopReason: 'end_turn' },
    };
    expect(analysis).toMatchObject({
      ...attribution,
      inputTokens: 140,
      outputTokens: 35,
      cachedInputTokens: 30,
      cacheWriteTokens: 25,
      cacheWrite1hTokens: 4,
      turnUsage: [{ tierKey: 100 }, { tierKey: 100000 }],
    });
    expect(analysis.costUsd).toBeCloseTo(519.75 / 1_000_000, 12);
    expect(triage).toMatchObject({
      ...attribution,
      inputTokens: 60,
      outputTokens: 10,
      cachedInputTokens: 35,
      cacheWriteTokens: 20,
      cacheWrite1hTokens: 5,
      rates: { tierKey: 100000 },
    });
    expect(triage.costUsd).toBeCloseTo(326.75 / 1_000_000, 12);
    expect(analysis.requestId).toMatch(/^[\da-f-]{36}$/);
    expect(triage.requestId).toMatch(/^[\da-f-]{36}$/);
    expect(analysis.requestId).not.toBe(triage.requestId);
    expect(JSON.stringify(mocks.record.mock.calls)).not.toMatch(/Example subject|Example body|example\.com|email-1/);
    expect(mocks.updateEmail).toHaveBeenCalledOnce();
    expect(mocks.storeTriage).toHaveBeenCalledOnce();
    expect(mocks.findOrganization).not.toHaveBeenCalled();
  });

  it('attributes analysis and triage to the real organization with one lookup and no charge', async () => {
    mocks.findUser.mockResolvedValue({ id: 'owner-1', organizationId: 'org-1' });
    await run();
    expect(mocks.findOrganization).toHaveBeenCalledExactlyOnceWith('org-1');
    expect(mocks.record).toHaveBeenCalledTimes(2);
    for (const [event] of mocks.record.mock.calls) {
      expect(event).toMatchObject({
        userId: 'owner-1',
        ownerId: 'org-1',
        ownerType: CreditHolderType.Organization,
        creditsCharged: 0,
      });
    }
  });

  it('awaits organization resolution before writing usage or persisting analysis results', async () => {
    mocks.findUser.mockResolvedValue({ id: 'owner-1', organizationId: 'org-1' });
    const lookup = Promise.withResolvers<{ id: string }>();
    mocks.findOrganization.mockReturnValue(lookup.promise);
    const finished = vi.fn();
    const pending = Promise.resolve(run()).then(finished);
    await vi.waitFor(() => expect(mocks.findOrganization).toHaveBeenCalledOnce());
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.updateEmail).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    lookup.resolve({ id: 'org-1' });
    await pending;
    expect(mocks.findOrganization).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.updateEmail).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'rejected'] as const)(
    'skips rows instead of using personal ownership when organization lookup is %s',
    async reason => {
      mocks.findUser.mockResolvedValue({ id: 'owner-1', organizationId: 'org-1' });
      if (reason === 'missing') mocks.findOrganization.mockResolvedValue(null);
      else mocks.findOrganization.mockRejectedValue(new Error('private lookup details'));
      await expect(run()).resolves.toBeUndefined();
      expect(mocks.findOrganization).toHaveBeenCalledOnce();
      expect(mocks.complete).toHaveBeenCalledTimes(2);
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.updateEmail).toHaveBeenCalledOnce();
      expect(mocks.storeTriage).toHaveBeenCalledOnce();
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        reason === 'missing'
          ? 'Email model usage organization is missing'
          : 'Could not look up email model usage organization'
      );
      expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain('private lookup details');
    }
  );

  it('awaits an unsuccessful organization lookup without replacing the original provider failure', async () => {
    mocks.findUser.mockResolvedValue({ id: 'owner-1', organizationId: 'org-1' });
    const providerError = new Error('provider rejected');
    const lookup = Promise.withResolvers<null>();
    mocks.findOrganization.mockReturnValue(lookup.promise);
    mocks.complete.mockImplementationOnce(async (_model, _messages, _options, callback) => {
      await callback([], aggregateUsage);
      throw providerError;
    });
    const failed = vi.fn();
    const pending = Promise.resolve(run()).catch(failed);
    await vi.waitFor(() => expect(mocks.findOrganization).toHaveBeenCalledOnce());
    expect(failed).not.toHaveBeenCalled();
    lookup.reject(new Error('private lookup details'));
    await pending;
    expect(failed).toHaveBeenCalledWith(providerError);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.updateEmail).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith('Could not look up email model usage organization');
  });

  it('awaits both writes before persisting their results and completing the worker', async () => {
    const analysisWrite = Promise.withResolvers<null>();
    const triageWrite = Promise.withResolvers<null>();
    mocks.record.mockReturnValueOnce(analysisWrite.promise).mockReturnValueOnce(triageWrite.promise);
    const finished = vi.fn();
    const pending = Promise.resolve(run()).then(finished);
    await vi.waitFor(() => expect(mocks.record).toHaveBeenCalledOnce());
    expect(mocks.updateEmail).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    analysisWrite.resolve(null);
    await vi.waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(2));
    expect(mocks.updateEmail).toHaveBeenCalledOnce();
    expect(mocks.storeTriage).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    triageWrite.resolve(null);
    await pending;
    expect(mocks.storeTriage).toHaveBeenCalledOnce();
  });

  it('records usage before rejecting invalid analysis output', async () => {
    mocks.complete.mockImplementationOnce(async (_model, _messages, _options, callback) => {
      await callback(['invalid JSON'], aggregateUsage);
    });
    await expect(run()).rejects.toThrow('LLM returned invalid JSON response');
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.updateEmail).not.toHaveBeenCalled();
  });

  it('awaits usage reported before a provider failure and preserves the provider error', async () => {
    const providerError = new Error('provider rejected');
    const write = Promise.withResolvers<null>();
    mocks.record.mockReturnValueOnce(write.promise);
    mocks.complete.mockImplementationOnce(async (_model, _messages, _options, callback) => {
      await callback([], { inputTokens: 42 });
      throw providerError;
    });
    const failed = vi.fn();
    const pending = Promise.resolve(run()).catch(failed);
    await vi.waitFor(() => expect(mocks.record).toHaveBeenCalledOnce());
    expect(failed).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 42, creditsCharged: 0 }));
    write.resolve(null);
    await pending;
    expect(failed).toHaveBeenCalledWith(providerError);
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('after email model failure'), {
      model: model.id,
    });
  });

  it('warns when the provider fails before reporting usage', async () => {
    const providerError = new Error('provider rejected');
    mocks.complete.mockRejectedValueOnce(providerError);
    await expect(run()).rejects.toBe(providerError);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not report'), { model: model.id });
  });

  it('warns and preserves successful analysis and triage when writes fail', async () => {
    const error = new Error('write failed');
    mocks.record.mockRejectedValue(error);
    await expect(run()).resolves.toBeUndefined();
    expect(mocks.updateEmail).toHaveBeenCalledOnce();
    expect(mocks.storeTriage).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('usage event failed'), error);
  });

  it('preserves a provider failure if writing its reported usage also fails', async () => {
    const providerError = new Error('provider rejected');
    const writeError = new Error('write failed');
    mocks.record.mockRejectedValueOnce(writeError);
    mocks.complete.mockImplementationOnce(async (_model, _messages, _options, callback) => {
      await callback([], aggregateUsage);
      throw providerError;
    });
    await expect(run()).rejects.toBe(providerError);
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('usage event failed'), writeError);
  });

  it('skips zero-only usage and still processes the analysis', async () => {
    mocks.settings.EnableEmailTriage = false;
    mocks.complete.mockImplementationOnce(async (_model, _messages, _options, callback) => {
      await callback([analysisReply], { turnUsage: [{ inputTokens: 0, outputTokens: 0 }] });
    });
    await expect(run()).resolves.toBeUndefined();
    expect(mocks.updateEmail).toHaveBeenCalledOnce();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.findOrganization).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'already analyzed'] as const)('records no events when analysis is %s', async reason => {
    if (reason === 'disabled') mocks.settings.EnableEmailAnalysis = false;
    else mocks.findEmail.mockResolvedValue({ ...email, aiAnalysis: { summary: 'Existing analysis' } });
    await run();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'already stored'] as const)('records only analysis when triage is %s', async reason => {
    if (reason === 'disabled') mocks.settings.EnableEmailTriage = false;
    else mocks.existsForEmail.mockResolvedValue(true);
    await run();
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledOnce();
  });
});
