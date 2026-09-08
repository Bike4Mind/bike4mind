import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The output budget the CLI path sends, and the credit hold it does NOT inflate.
 *
 * Regression cover for a silent truncation bug: this path used to hardcode
 * `options?.maxTokens ?? 4096`, which capped adaptive-reasoning models at 4096 TOTAL.
 * Those models spend extended thinking inside max_tokens, so reasoning consumed the
 * budget and the visible answer was cut off mid-sentence with nothing reported.
 *
 * Unlike the sibling cliCompletions suites, this one keeps the REAL
 * resolveOutputMaxTokens - a stubbed sizing rule could not catch a regression in the
 * rule itself, which is the whole subject here.
 */
vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
  isMemberCreditCapExceeded: vi.fn(() => false),
}));

let capturedOptions: Record<string, any> | undefined;
let availableModels: Array<Record<string, unknown>> = [];
/** Stop reason the stubbed backend reports on its terminal chunk; undefined = reports none. */
let backendStopReason: string | undefined;

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(async () => availableModels),
  getLlmByModel: vi.fn(() => ({
    currentModel: '',
    complete: vi.fn(async (_model: unknown, _messages: unknown, options: Record<string, any>, onChunk: any) => {
      capturedOptions = options;
      await onChunk([''], {
        inputTokens: 100,
        outputTokens: 50,
        ...(backendStopReason ? { stopReason: backendStopReason } : {}),
      });
    }),
  })),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 10),
  usdToCreditsStochastic: vi.fn(() => 10),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true), // enforceCredits = true
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 0.001),
}));

import { getTextModelCost, PREFLIGHT_RESERVATION_REASONING_OUTPUT_TOKENS } from '@bike4mind/common';
import { ADAPTIVE_THINKING_MAX_TOKENS_FLOOR } from '@bike4mind/llm-adapters';
import { DEFAULT_OUTPUT_MAX_TOKENS, usdToCredits } from '@bike4mind/utils';
import { executeCompletion } from './cliCompletions';
import { isMemberCreditCapExceeded } from './creditService';

const ADAPTIVE_MODEL = {
  id: 'adaptive-model',
  backend: 'anthropic',
  max_tokens: 128_000,
  can_think: true,
  thinkingStyle: 'adaptive' as const,
};

const PLAIN_MODEL = {
  id: 'plain-model',
  backend: 'anthropic',
  max_tokens: 8192,
};

function buildDb() {
  const users = {
    incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
    findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
  };
  return {
    db: {
      adminSettings: {} as any,
      apiKeys: {} as any,
      creditTransactions: {} as any,
      users: users as any,
      usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
      organizations: {} as any,
    },
    users,
  };
}

const baseParams = {
  userId: 'user1',
  messages: [{ role: 'user' as const, content: 'hi' }],
  onChunk: vi.fn().mockResolvedValue(undefined),
};

describe('executeCompletion - output budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
    backendStopReason = undefined;
    // clearAllMocks keeps implementations, so restore the flat cost stubs that the
    // org-member-cap test below swaps for proportional ones.
    vi.mocked(getTextModelCost).mockReturnValue(0.001);
    vi.mocked(usdToCredits).mockReturnValue(10);
  });

  it('sizes an absent budget to the adaptive floor for a reasoning model', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db });

    // The bug: this was 4096, leaving reasoning and the answer to fight over one budget.
    expect(capturedOptions?.maxTokens).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
  });

  it('leaves a non-reasoning model at the historical default', async () => {
    availableModels = [PLAIN_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'plain-model', db });

    expect(capturedOptions?.maxTokens).toBe(DEFAULT_OUTPUT_MAX_TOKENS);
  });

  it('never raises a budget the caller asked for explicitly', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, options: { maxTokens: 1000 } });

    expect(capturedOptions?.maxTokens).toBe(1000);
  });

  // The declared cap CLAMPS the sized budget, so the floor is a floor only up to what the
  // model can actually emit - over-requesting 400s the whole turn.
  it('clamps the sized budget to an adaptive model cap below the floor', async () => {
    availableModels = [{ ...ADAPTIVE_MODEL, max_tokens: 16_000 }];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db });

    expect(capturedOptions?.maxTokens).toBe(16_000);
  });

  it('clamps an over-large explicit budget to the model cap', async () => {
    availableModels = [PLAIN_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'plain-model', db, options: { maxTokens: 999_999 } });

    expect(capturedOptions?.maxTokens).toBe(PLAIN_MODEL.max_tokens);
  });

  // The reservation is atomically deducted and rejects the turn outright, so sizing it to
  // the (now much larger) ceiling would fail short prompts for users near their balance.
  it('estimates credits from the historical basis, not the raised ceiling', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db });

    expect(capturedOptions?.maxTokens).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    // The pre-flight estimate is the FIRST cost call (later ones settle actual usage).
    expect(vi.mocked(getTextModelCost).mock.calls[0]?.[2]).toBe(DEFAULT_OUTPUT_MAX_TOKENS);
  });

  it('estimates from an explicit budget when it is below the historical basis', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, options: { maxTokens: 500 } });

    expect(vi.mocked(getTextModelCost).mock.calls[0]?.[2]).toBe(500);
  });

  // An explicit budget above the historical basis raises the hold, but only up to the
  // reservation ceiling: a caller asking for 50K would otherwise be gated on a cost the turn
  // will not incur. Overshooting that ceiling settles as a shortfall debit, and the org member
  // cap - which has no settlement counterpart - is gated on the unshrunk ceiling instead.
  it('estimates from an explicit budget above the basis, clamped to the reservation ceiling', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, options: { maxTokens: 50_000 } });

    expect(vi.mocked(getTextModelCost).mock.calls[0]?.[2]).toBe(PREFLIGHT_RESERVATION_REASONING_OUTPUT_TOKENS);
  });

  /**
   * A catalog row that declares no output cap. The type says `max_tokens: number`, but that
   * is a claim about the data rather than a guarantee about it, and this shape reached the
   * real path: `Math.min(preferred, undefined)` resolved to NaN, which sized the reservation,
   * survived `usdToCredits`, and hit a Mongoose `currentCredits` write as an opaque
   * mid-stream cast error. The sibling metering suites stub the sizing rule out, so this is
   * the one place the REAL resolver meets a capless row.
   */
  describe('a model row declaring no output cap', () => {
    const CAPLESS_MODEL = { id: 'capless-model', backend: 'anthropic' };

    it('sends a finite budget rather than NaN', async () => {
      availableModels = [CAPLESS_MODEL];
      const { db } = buildDb();

      await executeCompletion({ ...baseParams, model: 'capless-model', db });

      expect(capturedOptions?.maxTokens).toBe(DEFAULT_OUTPUT_MAX_TOKENS);
    });

    it('keeps NaN out of the credit estimate and the deduction', async () => {
      availableModels = [CAPLESS_MODEL];
      const { db, users } = buildDb();
      vi.mocked(getTextModelCost).mockImplementation((_model, _input, output) => (output ?? 0) / 1000);
      vi.mocked(usdToCredits).mockImplementation(usd => usd);

      await executeCompletion({ ...baseParams, model: 'capless-model', db });

      expect(Number.isFinite(vi.mocked(getTextModelCost).mock.calls[0]?.[2] as number)).toBe(true);
      const reserved = users.incrementCredits.mock.calls[0]?.[1];
      expect(Number.isFinite(reserved)).toBe(true);
    });

    it('still honors an explicit budget instead of shrinking it to the fallback', async () => {
      availableModels = [CAPLESS_MODEL];
      const { db } = buildDb();

      await executeCompletion({ ...baseParams, model: 'capless-model', db, options: { maxTokens: 32_000 } });

      expect(capturedOptions?.maxTokens).toBe(32_000);
    });
  });

  // Independently of what sized it: a non-finite estimate must halt before either write.
  // incrementCredits would fail as a Mongoose cast error mid-stream, and the member-cap
  // check compares with `>`, which answers false for NaN and waves the request through.
  it('refuses to reserve a non-finite credit estimate', async () => {
    availableModels = [PLAIN_MODEL];
    const { db, users } = buildDb();
    vi.mocked(usdToCredits).mockReturnValue(Number.NaN);

    await expect(executeCompletion({ ...baseParams, model: 'plain-model', db })).rejects.toThrow(/non-finite/i);
    expect(users.incrementCredits).not.toHaveBeenCalled();
    expect(isMemberCreditCapExceeded).not.toHaveBeenCalled();
  });

  // The member cap is checked against the reservation, so an under-sized estimate is a
  // bypass of an administrator-configured control, not just an inaccurate hold.
  it('checks the org member cap against a large explicit budget', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();
    // Proportional so the cap sees the estimate rather than this suite's flat stub.
    vi.mocked(getTextModelCost).mockImplementation((_model, _input, output) => (output ?? 0) / 1000);
    vi.mocked(usdToCredits).mockImplementation(usd => usd);
    const organization = { id: 'org1', currentCredits: 100_000 };
    const organizations = {
      findById: vi.fn().mockResolvedValue(organization),
      incrementCredits: vi.fn().mockResolvedValue(organization),
      ensureUserDetails: vi.fn().mockResolvedValue(undefined),
      updateUserDetails: vi.fn().mockResolvedValue(undefined),
    };

    await executeCompletion({
      ...baseParams,
      model: 'adaptive-model',
      db: { ...db, organizations: organizations as any },
      billingOrganizationId: 'org1',
      options: { maxTokens: 50_000 },
    });

    expect(vi.mocked(isMemberCreditCapExceeded)).toHaveBeenCalledWith(organization, 'user1', 50);
  });

  // Without this the CLI cannot tell a cut-off reply from a finished one, which is what
  // let the starved budget go unreported for so long.
  it('re-emits a truncation stop reason on the terminal settlement event', async () => {
    availableModels = [ADAPTIVE_MODEL];
    backendStopReason = 'max_tokens';
    const { db } = buildDb();
    const onChunk = vi.fn().mockResolvedValue(undefined);

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, onChunk });

    // Latched from the backend's chunk and repeated last, so a client that inspects only
    // the final event still learns the reply was cut off.
    expect(onChunk.mock.calls.at(-1)?.[1]).toMatchObject({ stopReason: 'max_tokens' });
  });

  it('reports no stop reason when the backend gives none', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();
    const onChunk = vi.fn().mockResolvedValue(undefined);

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, onChunk });

    // Absence must stay absence - a fabricated reason would read as truncation downstream.
    expect(onChunk.mock.calls.at(-1)?.[1]?.stopReason).toBeUndefined();
  });
});
