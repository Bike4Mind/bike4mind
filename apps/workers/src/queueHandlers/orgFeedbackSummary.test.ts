import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModels, CreditHolderType, ModelBackend, type IUsageEventInput, type ModelInfo } from '@bike4mind/common';
import { LlmTimeoutError, SafetyRefusalError, type ICompletionBackend } from '@bike4mind/llm-adapters';

/**
 * The org feedback summary worker. Two things here are worth a test rather than a reading:
 * what reaches the LLM (counts, never text or member names), and that a failure tells the waiting
 * browser before it rethrows - the rethrow is what sends the message to SQS retries and then to
 * the quest-export DLQ, and neither of those is visible from the client.
 */

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  getSettingsValue: vi.fn(),
  getEffectiveLLMApiKeys: vi.fn(),
  buildApiKeyTable: vi.fn((keys: Record<string, string>) => keys),
  getAvailableModels: vi.fn(),
  getLlmByModel: vi.fn(),
  updateOne: vi.fn(async () => ({})),
  orgFeedbackReport: vi.fn(),
  findMemberUserIds: vi.fn(async () => ({ userIds: ['u1'], aclOnly: [], stampOnly: [] })),
  complete: vi.fn<ICompletionBackend['complete']>(),
  createUsageStore: vi.fn(),
  findUsageUser: vi.fn(),
  findUsageOrganization: vi.fn(),
  recordUsage: vi.fn<(event: IUsageEventInput) => Promise<null>>(),
  upload: vi.fn(async () => undefined),
  sendToClient: vi.fn(async () => undefined),
}));

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, { get: () => new Proxy({}, { get: () => 'mock' }) }),
}));

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  ChatModels: { CLAUDE_4_5_HAIKU_BEDROCK: 'claude-haiku', CLAUDE_4_5_HAIKU: 'anthropic-haiku' },
  ORG_FEEDBACK_SUMMARY_JOB_TYPE: 'orgFeedbackSummary',
  ORG_FEEDBACK_SUMMARY_TAG_LIMIT: 20,
}));

vi.mock('@bike4mind/database', () => ({
  OrgFeedbackSummaryJob: { findOne: h.findOne, updateOne: h.updateOne },
  orgFeedbackReport: h.orgFeedbackReport,
  apiKeyRepository: {},
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
}));

vi.mock('@bike4mind/database/zero-credit-operational-usage', () => ({
  createBoundedZeroCreditOperationalUsageStore: h.createUsageStore,
}));

vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findMemberUserIds: h.findMemberUserIds },
}));

vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  apiKeyService: { getEffectiveLLMApiKeys: h.getEffectiveLLMApiKeys },
}));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  buildApiKeyTable: h.buildApiKeyTable,
  getAvailableModels: h.getAvailableModels,
  getLlmByModel: h.getLlmByModel,
}));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    upload = h.upload;
  },
}));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: h.sendToClient }));

import { runOrgFeedbackSummary, summaryS3Key } from './orgFeedbackSummary';

const SUMMARY_JOB_ID = 'job-1';
const ORG_ID = 'org-1';
const MEMBER_NAME = 'Casey Member';

const message = {
  jobType: 'orgFeedbackSummary' as const,
  summaryJobId: SUMMARY_JOB_ID,
  organizationId: ORG_ID,
  startDate: '2026-08-01T00:00:00.000Z',
  endDate: '2026-08-31T23:59:59.999Z',
  userId: 'requester-1',
};

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the worker takes the real Logger
const run = (logger = makeLogger()) => runOrgFeedbackSummary(message, logger as any);

const frames = () => h.sendToClient.mock.calls.map(call => call[2] as { status: string; errorMessage?: string });

const tagRows = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `tag-${i}`, count: 100 - i }));

const REPORT = {
  range: { from: message.startDate, to: message.endDate },
  totals: { count: 7 },
  byDay: [{ day: '2026-08-02', count: 7 }],
  bySubject: [{ key: 'chat', count: 7 }],
  byType: [{ key: 'bug', count: 5 }],
  byStatus: [{ key: 'open', count: 6 }],
  byTag: [{ key: 'slow', count: 3 }],
  byTagTruncated: false,
  byMember: [{ userId: 'u1', displayName: MEMBER_NAME, count: 7 }],
  membership: { memberCount: 1, aclOnly: [], stampOnly: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettingsValue.mockResolvedValue(undefined);
  h.getEffectiveLLMApiKeys.mockResolvedValue({ anthropic: 'k' });
  h.getAvailableModels.mockResolvedValue([{ id: 'claude-haiku' }, { id: 'anthropic-haiku' }]);
  h.getLlmByModel.mockReturnValue({ complete: h.complete });
  h.findOne.mockResolvedValue({
    summaryJobId: SUMMARY_JOB_ID,
    organizationId: ORG_ID,
    requestedBy: message.userId,
    status: 'pending',
  });
  h.orgFeedbackReport.mockResolvedValue(REPORT);
  h.complete.mockImplementation(async (_model, _messages, _opts, onText) => {
    await onText(['Feedback was steady across the window.']);
  });
});

describe('runOrgFeedbackSummary', () => {
  it('keeps the default model when the summary setting is unset', async () => {
    await run();

    expect(h.complete.mock.calls[0][0]).toBe('claude-haiku');
    expect(JSON.parse(h.upload.mock.calls[0][0]).model).toBe('claude-haiku');
  });

  it('uses the selected available provider model for generation and the stored artifact', async () => {
    h.getSettingsValue.mockResolvedValue('anthropic-haiku');

    await run();

    expect(h.getSettingsValue).toHaveBeenCalledWith('OrgFeedbackSummaryModel');
    expect(h.complete.mock.calls[0][0]).toBe('anthropic-haiku');
    expect(h.getLlmByModel.mock.calls[0][1].modelInfo.id).toBe('anthropic-haiku');
    expect(JSON.parse(h.upload.mock.calls[0][0]).model).toBe('anthropic-haiku');
  });

  it.each([
    { provider: 'kimi', model: 'kimi-k3' },
    { provider: 'deepseek', model: 'deepseek-flash' },
  ])('passes the configured $provider key through to model discovery', async ({ provider, model }) => {
    h.getSettingsValue.mockResolvedValue(model);
    h.getEffectiveLLMApiKeys.mockResolvedValue({ [provider]: 'provider-key' });
    h.getAvailableModels.mockImplementation(async (keys: Record<string, string>) =>
      keys[provider] ? [{ id: model }] : []
    );

    await run();

    expect(h.buildApiKeyTable).toHaveBeenCalledWith({ [provider]: 'provider-key' });
    expect(h.getAvailableModels).toHaveBeenCalledWith({ [provider]: 'provider-key' });
    expect(h.complete.mock.calls[0][0]).toBe(model);
    expect(JSON.parse(h.upload.mock.calls[0][0]).model).toBe(model);
  });

  it('fails before inference when the explicitly selected model is unavailable', async () => {
    h.getSettingsValue.mockResolvedValue('anthropic-haiku');
    h.getAvailableModels.mockResolvedValue([{ id: 'claude-haiku' }]);

    await expect(run()).rejects.toThrow('Summary model anthropic-haiku is not available');

    expect(h.complete).not.toHaveBeenCalled();
    expect(h.getLlmByModel).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(frames().at(-1)?.status).toBe('failed');
  });

  it('sends the LLM counts only - no member names', async () => {
    await run();

    const prompt = JSON.stringify(h.complete.mock.calls[0][1]);
    expect(prompt).toContain('bug: 5');
    expect(prompt).toContain('Total items: 7');
    expect(prompt).not.toContain(MEMBER_NAME);
    expect(prompt).not.toContain('u1');
  });

  describe('partial tag list note', () => {
    const PARTIAL_NOTE = 'more tags exist, so do not describe this as the complete tag breakdown';
    const promptFor = async (byTagCount: number | null, byTagTruncated: boolean) => {
      h.orgFeedbackReport.mockResolvedValue({
        ...REPORT,
        byTagTruncated,
        ...(byTagCount === null ? {} : { byTag: tagRows(byTagCount) }),
      });
      await run();
      return JSON.stringify(h.complete.mock.calls[0][1]);
    };

    // A truncated report is always exactly ORG_FEEDBACK_BY_TAG_LIMIT (50) rows: FeedbackReportQueries
    // sets the flag only when more matched, and slices to the limit.
    it('says the list is a cut when the report was truncated', async () => {
      const prompt = await promptFor(50, true);
      expect(prompt).toContain(PARTIAL_NOTE);
      expect(prompt).toContain('only the top 20 tags by count are listed');
      expect(prompt).toContain('tag-19');
      expect(prompt).not.toContain('tag-20');
    });

    it('stays quiet when the report was not truncated and every tag fits', async () => {
      expect(await promptFor(null, false)).not.toContain(PARTIAL_NOTE);
    });

    it('stays quiet at exactly the prompt limit', async () => {
      expect(await promptFor(20, false)).not.toContain(PARTIAL_NOTE);
    });

    it('says the list is a cut when the prompt limit drops tags the report kept', async () => {
      const prompt = await promptFor(21, false);
      expect(prompt).toContain(PARTIAL_NOTE);
      expect(prompt).toContain('only the top 20 tags by count are listed');
    });
  });

  it('writes the artifact and releases the window on success', async () => {
    h.orgFeedbackReport.mockResolvedValue({ ...REPORT, byTag: tagRows(50), byTagTruncated: true });
    await run();

    const [payload, key] = h.upload.mock.calls[0];
    expect(key).toBe(summaryS3Key(ORG_ID, SUMMARY_JOB_ID));
    expect(JSON.parse(payload as string)).toMatchObject({
      summaryJobId: SUMMARY_JOB_ID,
      summary: 'Feedback was steady across the window.',
      // The truncation flag has to survive into the stored artifact: the read route parses it back
      // out of S3, and a caption on a stale artifact is the only place a reader learns the tag
      // list was cut.
      counts: { totals: { count: 7 }, byTagTruncated: true },
    });
    // activeKey moving to the job's own id is what frees this window for a re-run.
    expect(h.updateOne).toHaveBeenLastCalledWith(
      { summaryJobId: SUMMARY_JOB_ID },
      { status: 'completed', s3Key: key, activeKey: SUMMARY_JOB_ID }
    );
    expect(frames().map(f => f.status)).toEqual(['processing', 'processing', 'completed']);
  });

  it('serializes byTagTruncated: false rather than dropping the key on an empty population', async () => {
    h.orgFeedbackReport.mockResolvedValue({
      range: { from: message.startDate, to: message.endDate },
      totals: { count: 0 },
      byDay: [],
      bySubject: [],
      byType: [],
      byStatus: [],
      byTag: [],
      byTagTruncated: false,
      byMember: [],
      membership: { memberCount: 0, aclOnly: [], stampOnly: [] },
    });

    await run();

    // Asserted after the JSON round-trip the upload actually performs: JSON.stringify omits an
    // undefined value entirely, and an absent key is what the artifact contract reserves for one
    // written before the field existed. Reading the in-memory object would miss that.
    const { counts } = JSON.parse(h.upload.mock.calls[0][0] as string);
    expect('byTagTruncated' in counts).toBe(true);
    expect(counts.byTagTruncated).toBe(false);
  });

  it('resolves and keeps the completed status when only the completion frame rejects', async () => {
    h.sendToClient.mockImplementation(async (_userId: unknown, _endpoint: unknown, payload: { status: string }) => {
      if (payload.status === 'completed') throw new Error('websocket gone');
    });

    await expect(run()).resolves.toBeUndefined();

    expect(h.updateOne).toHaveBeenLastCalledWith(
      { summaryJobId: SUMMARY_JOB_ID },
      { status: 'completed', s3Key: summaryS3Key(ORG_ID, SUMMARY_JOB_ID), activeKey: SUMMARY_JOB_ID }
    );
    expect(h.updateOne.mock.calls.some(call => (call[1] as { status?: string })?.status === 'failed')).toBe(false);
  });

  it('reports the failure to the client before rethrowing to SQS', async () => {
    h.complete.mockRejectedValue(new Error('bedrock unavailable'));

    await expect(run()).rejects.toThrow('bedrock unavailable');

    const failed = frames().at(-1);
    expect(failed).toMatchObject({ status: 'failed', errorMessage: 'bedrock unavailable' });
    expect(h.updateOne).toHaveBeenLastCalledWith(
      { summaryJobId: SUMMARY_JOB_ID },
      { status: 'failed', errorMessage: 'bedrock unavailable', activeKey: SUMMARY_JOB_ID }
    );
  });

  it('still rethrows the original error when marking the job failed also rejects', async () => {
    h.complete.mockRejectedValue(new Error('bedrock unavailable'));
    h.updateOne.mockImplementation(async (_filter: unknown, update: { status?: string }) => {
      if (update?.status === 'failed') throw new Error('mongo unavailable');
      return {};
    });

    await expect(run()).rejects.toThrow('bedrock unavailable');

    const failed = frames().at(-1);
    expect(failed).toMatchObject({ status: 'failed', errorMessage: 'bedrock unavailable' });
  });

  it('still rethrows the original error when the failure progress frame also rejects', async () => {
    h.complete.mockRejectedValue(new Error('bedrock unavailable'));
    h.sendToClient.mockImplementation(async (_userId: unknown, _endpoint: unknown, payload: { status: string }) => {
      if (payload.status === 'failed') throw new Error('websocket gone');
    });

    await expect(run()).rejects.toThrow('bedrock unavailable');

    expect(h.updateOne).toHaveBeenLastCalledWith(
      { summaryJobId: SUMMARY_JOB_ID },
      { status: 'failed', errorMessage: 'bedrock unavailable', activeKey: SUMMARY_JOB_ID }
    );
  });

  it('drops a redelivery whose job row has aged out', async () => {
    h.findOne.mockResolvedValue(null);
    const logger = makeLogger();

    await run(logger);

    expect(logger.warn).toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.sendToClient).not.toHaveBeenCalled();
  });

  it('re-emits completion instead of paying for a second LLM pass', async () => {
    h.findOne.mockResolvedValue({ summaryJobId: SUMMARY_JOB_ID, status: 'completed' });

    await run();

    expect(h.complete).not.toHaveBeenCalled();
    expect(h.getSettingsValue).not.toHaveBeenCalled();
    expect(h.getEffectiveLLMApiKeys).not.toHaveBeenCalled();
    expect(h.getAvailableModels).not.toHaveBeenCalled();
    expect(h.getLlmByModel).not.toHaveBeenCalled();
    expect(h.orgFeedbackReport).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.updateOne).not.toHaveBeenCalled();
    expect(frames()).toEqual([
      {
        summaryJobId: SUMMARY_JOB_ID,
        organizationId: ORG_ID,
        status: 'completed',
        progress: 100,
        action: 'org_feedback_summary_progress',
      },
    ]);
  });
});

it('releases the persisted hold when the cooperative budget expires before work', async () => {
  await expect(
    runOrgFeedbackSummary(message, makeLogger() as never, () => {
      throw new Error('run budget exhausted');
    })
  ).rejects.toThrow('run budget exhausted');
  expect(h.complete).not.toHaveBeenCalled();
  expect(h.updateOne).toHaveBeenCalledWith(
    { summaryJobId: SUMMARY_JOB_ID },
    { status: 'failed', activeKey: SUMMARY_JOB_ID, errorMessage: 'run budget exhausted' }
  );
});

it.each([2, 4])('releases the active window and suppresses the next side effect at checkpoint %s', async index => {
  let check = 0;
  await expect(
    runOrgFeedbackSummary(message, makeLogger() as never, () => {
      if (++check === index) throw new Error('run budget exhausted');
    })
  ).rejects.toThrow('run budget exhausted');
  expect(index === 2 ? h.complete : h.upload).not.toHaveBeenCalled();
  expect(h.updateOne).toHaveBeenLastCalledWith(
    { summaryJobId: SUMMARY_JOB_ID },
    { status: 'failed', activeKey: SUMMARY_JOB_ID, errorMessage: 'run budget exhausted' }
  );
});

describe('org feedback summary usage', () => {
  const model: ModelInfo = {
    id: ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
    name: 'Test model',
    type: 'text',
    backend: ModelBackend.Bedrock,
    contextWindow: 100_000,
    max_tokens: 4096,
    pricing: {
      100: { input: 1e-6, output: 2e-6, cache_read: 0.1e-6, cache_write: 1.25e-6 },
      100000: { input: 3e-6, output: 5e-6, cache_read: 0.3e-6, cache_write: 3.75e-6 },
    },
    priceSource: 'catalog',
    priceRowId: 'fixture-rate',
  };

  const actualUsage = {
    inputTokens: 60,
    outputTokens: 10,
    cacheReadInputTokens: 35,
    cacheCreationInputTokens: 20,
    cacheWrite1hInputTokens: 5,
    stopReason: 'end_turn',
  };

  beforeEach(() => {
    h.updateOne.mockReset().mockResolvedValue({});
    h.sendToClient.mockReset().mockResolvedValue(undefined);
    h.upload.mockReset().mockResolvedValue(undefined);
    h.recordUsage.mockReset().mockResolvedValue(null);
    h.findUsageUser.mockReset().mockResolvedValue({ id: message.userId, organizationId: 'other-organization' });
    h.findUsageOrganization.mockReset().mockResolvedValue({ id: ORG_ID });
    h.createUsageStore.mockReturnValue({
      findUserById: h.findUsageUser,
      findOrganizationById: h.findUsageOrganization,
      usageEvents: { record: h.recordUsage },
    });
    h.getAvailableModels.mockResolvedValue([model]);
    h.complete.mockImplementation(async (_model, _messages, _options, onText) => {
      await onText(['Feedback was steady.'], actualUsage);
    });
  });

  afterEach(() => vi.useRealTimers());

  it('prices the whole prompt and attributes the actual requester and target organization', async () => {
    await run();

    expect(h.createUsageStore).toHaveBeenCalledExactlyOnceWith({ lookupTimeoutMS: 10_000, writeTimeoutMS: 20_000 });
    expect(h.findUsageUser).toHaveBeenCalledExactlyOnceWith(message.userId);
    expect(h.findUsageOrganization).toHaveBeenCalledExactlyOnceWith(ORG_ID);
    expect(h.recordUsage).toHaveBeenCalledOnce();
    const [[row]] = h.recordUsage.mock.calls;
    expect(row).toMatchObject({
      feature: 'operations',
      source: 'system',
      userId: message.userId,
      ownerId: ORG_ID,
      ownerType: CreditHolderType.Organization,
      model: model.id,
      provider: 'bedrock',
      inputTokens: 60,
      outputTokens: 10,
      cachedInputTokens: 35,
      cacheWriteTokens: 20,
      cacheWrite1hTokens: 5,
      creditsCharged: 0,
      priceSource: 'catalog',
      priceRowId: 'fixture-rate',
      rates: { tierKey: 100000 },
      requestMeta: { stopReason: 'end_turn' },
    });
    expect(row.costUsd).toBeCloseTo(326.75 / 1_000_000, 12);
    expect(row.requestId).toMatch(/^[a-f\d-]{36}$/);
    expect(JSON.stringify(row)).not.toMatch(/Feedback was steady|window|job-1|2026-08|Casey Member/);
  });

  it('prices provider turns in their own tiers without double-counting aggregate snapshots', async () => {
    h.complete.mockImplementationOnce(async (_model, _messages, _options, onText) => {
      await onText(['Feedback was steady.'], actualUsage);
      await onText([], {
        turnUsage: [
          { inputTokens: 50, outputTokens: 20, cacheReadInputTokens: 10, cacheCreationInputTokens: 10 },
          {
            inputTokens: 90,
            outputTokens: 15,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 15,
            cacheWrite1hInputTokens: 4,
          },
        ],
      });
    });
    await run();
    const [[row]] = h.recordUsage.mock.calls;
    expect(row).toMatchObject({
      inputTokens: 140,
      outputTokens: 35,
      cachedInputTokens: 30,
      cacheWriteTokens: 25,
      cacheWrite1hTokens: 4,
      turnUsage: [{ tierKey: 100 }, { tierKey: 100000 }],
    });
    expect(row.costUsd).toBeCloseTo(519.75 / 1_000_000, 12);
  });

  it('records cache-only usage even when the model is priced at zero', async () => {
    h.getAvailableModels.mockResolvedValue([{ ...model, pricing: {}, freeToRun: true }]);
    h.complete.mockImplementationOnce(async (_model, _messages, _options, onText) => {
      await onText(['Feedback was steady.'], { cacheReadInputTokens: 18 });
    });

    await run();

    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cachedInputTokens: 18, costUsd: 0, creditsCharged: 0 })
    );
  });

  it('joins provider settlement after the deadline, latches late usage, and awaits the insert before failing', async () => {
    vi.useFakeTimers();
    const inFlight = Promise.withResolvers<void>();
    const insert = Promise.withResolvers<null>();
    h.recordUsage.mockReturnValueOnce(insert.promise);
    h.complete.mockImplementationOnce(async (_model, _messages, _options, onText) => {
      await inFlight.promise;
      await onText(['Must not be uploaded'], actualUsage);
    });
    const outcome = vi.fn();
    const pending = run().catch(outcome);
    await vi.advanceTimersByTimeAsync(59_999);
    const [, , options] = h.complete.mock.calls[0];
    expect(options).toMatchObject({ stream: false, retryMode: 'abort-aware', maxTokens: 2000 });
    expect(options.abortSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(options.abortSignal?.aborted).toBe(true);
    expect(outcome).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();

    inFlight.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        providerInputTokens: 60,
        providerOutputTokens: 10,
        settledBasis: 'provider',
        status: 'timeout',
        creditsCharged: 0,
      })
    );
    expect(outcome).not.toHaveBeenCalled();
    expect(h.updateOne).toHaveBeenCalledTimes(1);

    insert.resolve(null);
    await pending;
    expect(outcome).toHaveBeenCalledExactlyOnceWith(options.abortSignal?.reason);
    expect(options.abortSignal?.reason).toMatchObject({ message: 'Summary generation timeout after 60000ms' });
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.updateOne).toHaveBeenLastCalledWith(
      { summaryJobId: SUMMARY_JOB_ID },
      { status: 'failed', activeKey: SUMMARY_JOB_ID, errorMessage: 'Summary generation timeout after 60000ms' }
    );
  });

  it('disarms the provider deadline before waiting on owner reads and the usage write', async () => {
    vi.useFakeTimers();
    const provider = Promise.withResolvers<void>();
    const user = Promise.withResolvers<{ id: string }>();
    const insert = Promise.withResolvers<null>();
    h.findUsageUser.mockReturnValueOnce(user.promise);
    h.recordUsage.mockReturnValueOnce(insert.promise);
    h.complete.mockImplementationOnce(async (_model, _messages, _options, onText) => {
      await provider.promise;
      await onText(['Feedback was steady.'], actualUsage);
    });

    const pending = run();
    await vi.advanceTimersByTimeAsync(59_999);
    provider.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.findUsageUser).toHaveBeenCalledOnce();
    expect(h.findUsageOrganization).toHaveBeenCalledOnce();
    expect(h.complete.mock.calls[0][2].abortSignal?.aborted).toBe(false);
    expect(h.recordUsage).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();

    user.resolve({ id: message.userId });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.recordUsage).toHaveBeenCalledOnce();
    expect(h.upload).not.toHaveBeenCalled();
    insert.resolve(null);
    await pending;
    expect(h.upload).toHaveBeenCalledOnce();
    expect(frames().at(-1)?.status).toBe('completed');
  });

  it('joins both owner reads even when one rejects', async () => {
    vi.useFakeTimers();
    const otherRead = Promise.withResolvers<null>();
    h.findUsageUser.mockRejectedValueOnce(new Error('database fault'));
    h.findUsageOrganization.mockReturnValueOnce(otherRead.promise);
    const pending = run();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
    otherRead.resolve(null);
    await pending;
    expect(h.upload).toHaveBeenCalledOnce();
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('records callback usage before rethrowing an ordinary provider error', async () => {
    vi.useFakeTimers();
    const originalError = new Error('provider unavailable');
    const insert = Promise.withResolvers<null>();
    h.recordUsage.mockReturnValueOnce(insert.promise);
    h.complete.mockImplementationOnce(async (_model, _messages, _options, onText) => {
      await onText([], actualUsage);
      throw originalError;
    });
    const outcome = vi.fn();
    const pending = run().catch(outcome);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 60 }));
    expect(outcome).not.toHaveBeenCalled();
    expect(h.updateOne).toHaveBeenCalledTimes(1);
    insert.resolve(null);
    await pending;
    expect(outcome).toHaveBeenCalledExactlyOnceWith(originalError);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('uses typed refusal usage and preserves the original error after a failed insert', async () => {
    const refusal = new SafetyRefusalError(model.id, {
      inputTokens: 18,
      outputTokens: 2,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 0,
    });
    h.complete.mockRejectedValueOnce(refusal);
    h.recordUsage.mockRejectedValueOnce(new Error('private driver message'));

    const logger = makeLogger();
    await expect(run(logger)).rejects.toBe(refusal);
    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ inputTokens: 18, outputTokens: 2, cachedInputTokens: 5, status: 'refusal' })
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private driver message');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/usage event failed/), expect.any(Error));
    expect(h.upload).not.toHaveBeenCalled();
    expect(frames().at(-1)?.status).toBe('failed');
  });

  it('completes the job after an isolated usage write failure', async () => {
    h.recordUsage.mockRejectedValueOnce(new Error('private driver message'));
    const logger = makeLogger();
    await run(logger);
    expect(h.recordUsage).toHaveBeenCalledOnce();
    expect(h.upload).toHaveBeenCalledOnce();
    expect(frames().at(-1)?.status).toBe('completed');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/usage event failed/), expect.any(Error));
  });

  it.each(['owner-mismatch', 'missing-user', 'missing-organization', 'no-usage', 'zero-only'] as const)(
    'still completes without creating a usage event for %s',
    async scenario => {
      if (scenario === 'owner-mismatch') {
        h.findOne.mockResolvedValue({
          summaryJobId: SUMMARY_JOB_ID,
          requestedBy: 'someone-else',
          organizationId: ORG_ID,
        });
      }
      if (scenario === 'missing-user') h.findUsageUser.mockResolvedValue(null);
      if (scenario === 'missing-organization') h.findUsageOrganization.mockResolvedValue(null);
      if (scenario === 'no-usage' || scenario === 'zero-only') {
        h.complete.mockImplementationOnce(async (_model, _messages, _options, onText) => {
          await onText(
            ['Feedback was steady.'],
            scenario === 'zero-only' ? { turnUsage: [{ inputTokens: 0, outputTokens: 0 }] } : undefined
          );
        });
      }
      await run();
      expect(h.recordUsage).not.toHaveBeenCalled();
      if (scenario === 'owner-mismatch' || scenario === 'no-usage' || scenario === 'zero-only') {
        expect(h.createUsageStore).not.toHaveBeenCalled();
      }
      expect(h.upload).toHaveBeenCalledOnce();
    }
  );

  it('does not fabricate a row for an ordinary provider failure with no usage', async () => {
    const error = new Error('provider unavailable');
    h.complete.mockRejectedValueOnce(error);
    await expect(run()).rejects.toBe(error);
    expect(h.createUsageStore).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('records an empty provider response before upload validation rejects', async () => {
    h.complete.mockImplementationOnce(async (_model, _messages, _options, onText) => onText([], actualUsage));
    await expect(run()).rejects.toThrow('Empty summary response from LLM');
    expect(h.recordUsage).toHaveBeenCalledOnce();
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('gives each paid redelivery its own usage row while completed and expired replays remain free', async () => {
    h.upload.mockRejectedValueOnce(new Error('object write failed'));
    await expect(run()).rejects.toThrow('object write failed');
    const job = { summaryJobId: SUMMARY_JOB_ID, requestedBy: message.userId, organizationId: ORG_ID };
    h.findOne.mockResolvedValue({ ...job, status: 'failed' });
    await run();
    h.findOne.mockResolvedValue({ ...job, status: 'completed' });
    await run();
    h.findOne.mockResolvedValue(null);
    await run();

    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.recordUsage).toHaveBeenCalledTimes(2);
    expect(new Set(h.recordUsage.mock.calls.map(([row]) => row.requestId)).size).toBe(2);
  });

  it('prices usage carried by a provider timeout error', async () => {
    const timeout = new LlmTimeoutError('request', 1000, 'provider timeout', {
      usage: { inputTokens: 40, cacheReadInputTokens: 10, cacheCreationInputTokens: 0, outputTokens: 4 },
    });
    h.complete.mockRejectedValueOnce(timeout);
    await expect(run()).rejects.toBe(timeout);
    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        providerInputTokens: 40,
        providerOutputTokens: 4,
        cachedInputTokens: 10,
        status: 'timeout',
        settledBasis: 'provider',
        creditsCharged: 0,
      })
    );
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('preserves the job outcome when the usage store cannot be created', async () => {
    h.createUsageStore.mockImplementationOnce(() => {
      throw new Error('store unavailable');
    });
    await run();
    expect(h.recordUsage).not.toHaveBeenCalled();
    expect(h.upload).toHaveBeenCalledOnce();
  });

  it('prices a refusal that carries per-turn usage from the turns', async () => {
    const refusal = new SafetyRefusalError(model.id, {
      inputTokens: 18,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      turnUsage: [
        { inputTokens: 11, outputTokens: 1 },
        { inputTokens: 7, outputTokens: 1 },
      ],
    });
    h.complete.mockRejectedValueOnce(refusal);
    await expect(run()).rejects.toBe(refusal);
    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ inputTokens: 18, outputTokens: 2, status: 'refusal' })
    );
  });

  it('does not record usage when the job row belongs to another organization', async () => {
    h.findOne.mockResolvedValue({
      summaryJobId: SUMMARY_JOB_ID,
      organizationId: 'other-organization',
      requestedBy: message.userId,
      status: 'pending',
    });
    await run();
    expect(h.findUsageUser).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('requires the summary reserve immediately before inference', async () => {
    const checkBudget = vi.fn((minimumRemainingMs?: number) => {
      if (minimumRemainingMs) throw new Error('reserve unavailable');
    });
    await expect(runOrgFeedbackSummary(message, makeLogger() as never, checkBudget)).rejects.toThrow(
      'reserve unavailable'
    );
    expect(checkBudget.mock.calls).toEqual([[], [], [120_000]]);
    expect(h.getLlmByModel).toHaveBeenCalledOnce();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(frames().at(-1)?.status).toBe('failed');
  });
});
