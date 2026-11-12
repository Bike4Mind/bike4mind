import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompletionRunAttribution } from '@bike4mind/common';

// Run lineage and the session ride along on the rows a completion already writes; nothing new is
// charged. Fixtures mirror cliCompletions.ledgerRow.test.ts.
vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));
const complete = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/llm-adapters', () => ({
  buildApiKeyTable: (keys: object) => keys,
  reasonsWithinOutputBudget: vi.fn(() => false),
  isAdaptiveThinkingByDefault: vi.fn(() => false),
  resolveOutputMaxTokens: vi.fn(
    ({ requested, fallback }: { requested?: number; fallback: number }) => requested ?? fallback
  ),
  getAvailableModels: vi.fn().mockResolvedValue([
    {
      id: 'test-model',
      type: 'text',
      backend: 'anthropic',
      pricing: { 200_000: { input: 1 / 1_000_000, output: 1 / 1_000_000 } },
    },
  ]),
  getLlmByModel: vi.fn(() => ({ currentModel: '', complete })),
}));
const enforceCredits = vi.hoisted(() => ({ value: true }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 1),
  usdToCreditsStochastic: vi.fn(() => 1),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => enforceCredits.value),
  getSettingsByNames: vi.fn(),
}));

import { executeCompletion, type CompletionParams } from './cliCompletions';
import { subtractCredits } from './creditService';

const RUN: CompletionRunAttribution = {
  runId: '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80',
  role: 'worker',
  purpose: 'explore',
  taskId: 'task-1',
  attemptId: 'attempt-2',
  parentSessionId: 'root-session',
};

// Partial repository doubles - only the methods executeCompletion calls are stubbed.
function buildDb() {
  const user = { id: 'user1', currentCredits: 100 };
  const usageEvents = { record: vi.fn().mockResolvedValue(undefined) };
  const db = {
    adminSettings: {} as never,
    apiKeys: {} as never,
    creditTransactions: {} as never,
    users: {
      incrementCredits: vi.fn().mockResolvedValue(user),
      findById: vi.fn().mockResolvedValue(user),
    } as never,
    usageEvents: usageEvents as never,
  };
  return { db, usageEvents };
}

/** The caller's session id is kept inside the run, never on the top-level usage event. */
const LINEAGE = { ...RUN, sessionId: 'worker-session' };

const run = (db: ReturnType<typeof buildDb>['db'], overrides: Partial<CompletionParams> = {}) =>
  executeCompletion({
    userId: 'user1',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    db,
    requestId: 'caller-request-id',
    sessionId: 'worker-session',
    run: RUN,
    source: 'desktop',
    onChunk: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

const failWith = (error: Error) =>
  complete.mockImplementation(async () => {
    throw error;
  });

describe('executeCompletion - run attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceCredits.value = true;
    complete.mockImplementation(async (_model, _messages, _options, onChunk) => {
      await onChunk(['hi'], { inputTokens: 12, outputTokens: 3 });
    });
  });

  it('records the run under metadata.run on the one ledger row, beside the caller request id', async () => {
    await run(buildDb().db);

    expect(vi.mocked(subtractCredits)).toHaveBeenCalledOnce();
    expect(vi.mocked(subtractCredits).mock.calls[0][0]).toMatchObject({
      type: 'completion_api_usage',
      sessionId: 'worker-session',
      metadata: expect.objectContaining({ run: LINEAGE, requestId: 'caller-request-id' }),
    });
  });

  it('records the session and run on the settled usage event', async () => {
    const { db, usageEvents } = buildDb();
    await run(db);

    expect(usageEvents.record).toHaveBeenCalledOnce();
    expect(usageEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'caller-request-id',
        run: LINEAGE,
        status: 'ok',
      })
    );
    expect(usageEvents.record.mock.calls[0][0]).not.toHaveProperty('sessionId');
  });

  it('leaves run off the ledger metadata and the usage event of an unattributed request', async () => {
    const { db, usageEvents } = buildDb();
    await run(db, { run: undefined });

    expect(vi.mocked(subtractCredits).mock.calls[0][0].metadata).not.toHaveProperty('run');
    expect(usageEvents.record.mock.calls[0][0].run).toBeUndefined();
  });

  it('records the session and run on the unbilled timeout row', async () => {
    const { db, usageEvents } = buildDb();
    const error = Object.assign(new Error('Anthropic API stream timeout'), {
      name: 'LlmTimeoutError',
      usage: { inputTokens: 1200 },
    });
    failWith(error);

    await expect(run(db)).rejects.toBe(error);

    expect(usageEvents.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'timeout', run: LINEAGE }));
  });

  it('records the session and run on the refusal row', async () => {
    const { db, usageEvents } = buildDb();
    const error = new Error('Safety classifier refusal');
    failWith(error);

    await expect(run(db)).rejects.toBe(error);

    expect(usageEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'refusal', run: LINEAGE, creditsCharged: 0 })
    );
  });

  it('reports the committed settlement once, with the caller request id', async () => {
    const onSettled = vi.fn();
    await run(buildDb().db, { onSettled });

    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith({
      requestId: 'caller-request-id',
      committed: true,
      creditsCharged: 1,
      usdCost: expect.any(Number),
    });
  });

  it('reports an uncommitted settlement with nothing charged when the ledger write fails', async () => {
    vi.mocked(subtractCredits).mockRejectedValueOnce(new Error('ledger down'));
    const onSettled = vi.fn();
    await run(buildDb().db, { onSettled });

    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ committed: false, creditsCharged: 0 }));
  });

  it('logs and swallows a throwing settlement callback', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const onSettled = vi.fn(() => {
      throw new Error('listener failed');
    });
    await run(buildDb().db, { onSettled, logger: logger as unknown as CompletionParams['logger'] });

    expect(onSettled).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      '[CLI_CREDITS] onSettled callback threw',
      expect.objectContaining({ requestId: 'caller-request-id', error: 'listener failed' })
    );
  });

  it('reports no settlement when credits are not enforced', async () => {
    enforceCredits.value = false;
    const onSettled = vi.fn();
    await run(buildDb().db, { onSettled });

    expect(onSettled).not.toHaveBeenCalled();
  });
});
