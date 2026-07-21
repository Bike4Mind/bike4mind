import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures what executeCompletion actually hands the backend, so these tests pin the
// serverTools contract: opt-in server-side execution without disturbing the legacy
// wire-tools path that CLI/API clients rely on (they execute tools locally).
let capturedOptions: Record<string, any> | undefined;
let completeImpl: (onChunk: (text: string[], info?: Record<string, unknown>) => Promise<void>) => Promise<void>;

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', () => ({ subtractCredits: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn().mockResolvedValue([{ id: 'test-model', backend: 'anthropic' }]),
  getLlmByModel: vi.fn(() => ({
    currentModel: '',
    complete: vi.fn(async (_model: unknown, _messages: unknown, options: Record<string, any>, onChunk: any) => {
      capturedOptions = options;
      await completeImpl(onChunk);
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

import { executeCompletion } from './cliCompletions';

function buildDb() {
  const users = {
    incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100 }),
    findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100 }),
  };
  const org = { id: 'org1', currentCredits: 500, maxCreditsPerMember: null, userDetails: [] };
  const organizations = {
    findById: vi.fn().mockResolvedValue(org),
    incrementCredits: vi.fn().mockResolvedValue({ ...org, currentCredits: 490 }),
    updateUserDetails: vi.fn().mockResolvedValue(undefined),
  };
  const usageEvents = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    db: {
      adminSettings: {} as any,
      apiKeys: {} as any,
      creditTransactions: {} as any,
      users: users as any,
      usageEvents: usageEvents as any,
      organizations: organizations as any,
    },
    users,
    organizations,
    usageEvents,
  };
}

const baseParams = {
  userId: 'user1',
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  onChunk: vi.fn().mockResolvedValue(undefined),
};

function makeServerTool(name: string) {
  return {
    toolFn: async () => `${name} result`,
    toolSchema: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedOptions = undefined;
  completeImpl = async onChunk => {
    await onChunk([''], { inputTokens: 100, outputTokens: 50 });
  };
});

describe('executeCompletion - serverTools opt-in', () => {
  it('regression: without serverTools, wire tools are promoted with a no-op toolFn and executeTools stays false', async () => {
    const { db } = buildDb();
    const wireTool = { toolSchema: { name: 'client_tool', description: 'x', parameters: { type: 'object' } } };

    await executeCompletion({ ...baseParams, db, options: { tools: [wireTool as any] } });

    expect(capturedOptions!.executeTools).toBe(false);
    expect(capturedOptions!.tools).toHaveLength(1);
    expect(capturedOptions!.tools[0].toolSchema.name).toBe('client_tool');
    expect(await capturedOptions!.tools[0].toolFn({})).toBe(''); // the no-op stamp
  });

  it('regression: with neither tool param, tools are [] and executeTools is false', async () => {
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, db });

    expect(capturedOptions!.executeTools).toBe(false);
    expect(capturedOptions!.tools).toEqual([]);
    expect(capturedOptions!._internal).toBeUndefined();
    expect(capturedOptions!.abortSignal).toBeUndefined();
  });

  it('serverTools pass through by reference with executeTools true', async () => {
    const { db } = buildDb();
    const serverTools = [makeServerTool('search_knowledge_base'), makeServerTool('retrieve_knowledge_content')];

    await executeCompletion({ ...baseParams, db, serverTools });

    expect(capturedOptions!.executeTools).toBe(true);
    expect(capturedOptions!.tools).toBe(serverTools); // referential - no promotion, live toolFns intact
  });

  it('an EMPTY serverTools array behaves as the legacy no-tools path', async () => {
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, db, serverTools: [] });

    expect(capturedOptions!.executeTools).toBe(false);
    expect(capturedOptions!.tools).toEqual([]);
  });

  it('threads maxToolCalls and abortSignal to the backend when serverTools are on', async () => {
    const { db } = buildDb();
    const controller = new AbortController();

    await executeCompletion({
      ...baseParams,
      db,
      serverTools: [makeServerTool('search_knowledge_base')],
      maxToolCalls: 5,
      abortSignal: controller.signal,
    });

    expect(capturedOptions!._internal).toEqual({ maxToolCalls: 5 });
    expect(capturedOptions!.abortSignal).toBe(controller.signal);
  });

  it('rejects when BOTH serverTools and wire options.tools are set, before any reservation', async () => {
    const { db, users, organizations } = buildDb();
    const wireTool = { toolSchema: { name: 'client_tool', description: 'x', parameters: { type: 'object' } } };

    await expect(
      executeCompletion({
        ...baseParams,
        db,
        serverTools: [makeServerTool('search_knowledge_base')],
        options: { tools: [wireTool as any] },
      })
    ).rejects.toThrow(/mutually exclusive/);

    expect(users.incrementCredits).not.toHaveBeenCalled();
    expect(organizations.incrementCredits).not.toHaveBeenCalled();
  });

  it('bills the CUMULATIVE total across a multi-turn tool loop, not the last turn alone', async () => {
    // Mirrors the real backend contract: tool-turn emits carry zero tokens (assign-not-add
    // guard skips them), the terminal turn emits the accumulated whole-completion totals.
    const { db, usageEvents } = buildDb();
    completeImpl = async onChunk => {
      await onChunk(['tool output\n'], { inputTokens: 0, outputTokens: 0, toolsUsed: ['search_knowledge_base'] });
      await onChunk(['answer'], { inputTokens: 300, outputTokens: 80 });
    };

    await executeCompletion({ ...baseParams, db, serverTools: [makeServerTool('search_knowledge_base')] });

    expect(usageEvents.record).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 300, outputTokens: 80 }));
  });

  it('org-billed multi-turn loop settles the cumulative total against the org pool', async () => {
    const { db, organizations, usageEvents } = buildDb();
    completeImpl = async onChunk => {
      await onChunk(['tool output\n'], { inputTokens: 0, outputTokens: 0 });
      await onChunk(['answer'], { inputTokens: 300, outputTokens: 80 });
    };

    await executeCompletion({
      ...baseParams,
      db,
      billingOrganizationId: 'org1',
      serverTools: [makeServerTool('search_knowledge_base')],
    });

    expect(organizations.incrementCredits).toHaveBeenCalled();
    expect(usageEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'org1', userId: 'user1', inputTokens: 300, outputTokens: 80 })
    );
  });

  it('a mid-loop backend failure refunds the reservation exactly once and rethrows', async () => {
    const { db, users } = buildDb();
    completeImpl = async () => {
      throw new Error('backend exploded mid-loop');
    };

    await expect(
      executeCompletion({ ...baseParams, db, serverTools: [makeServerTool('search_knowledge_base')] })
    ).rejects.toThrow('backend exploded mid-loop');

    const refunds = users.incrementCredits.mock.calls.filter(([, delta]: [string, number]) => delta > 0);
    expect(refunds).toEqual([['user1', 10]]);
  });

  it('honors abortSignal fired mid-completion: aborts the backend and rethrows', async () => {
    const { db } = buildDb();
    const controller = new AbortController();
    // Emit one partial chunk, then abort and surface the AbortError like a real backend.
    completeImpl = async onChunk => {
      await onChunk(['partial\n'], { inputTokens: 60, outputTokens: 10 });
      controller.abort();
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    };

    await expect(
      executeCompletion({
        ...baseParams,
        db,
        serverTools: [makeServerTool('search_knowledge_base')],
        abortSignal: controller.signal,
      })
    ).rejects.toThrow(/aborted/i);
    expect(capturedOptions!.abortSignal).toBe(controller.signal);
  });

  it('records an errored usage event for an aborted alwaysRecordUsage run (org metering stays complete)', async () => {
    const { db, usageEvents, users } = buildDb();
    completeImpl = async onChunk => {
      // Partial provider spend accrues, then the client disconnects mid-run.
      await onChunk(['partial answer'], { inputTokens: 200, outputTokens: 25 });
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    };

    await expect(
      executeCompletion({
        ...baseParams,
        db,
        billingOrganizationId: 'org1',
        alwaysRecordUsage: true,
        serverTools: [makeServerTool('search_knowledge_base')],
      })
    ).rejects.toThrow(/aborted/i);

    // An org-visible ledger trace of the partial spend, charged 0 (reservation refunded).
    expect(usageEvents.record).toHaveBeenCalledTimes(1);
    expect(usageEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'org1',
        status: 'error',
        inputTokens: 200,
        outputTokens: 25,
        creditsCharged: 0,
      })
    );
    // Reservation refunded exactly once.
    const refunds = (db.users.incrementCredits as ReturnType<typeof vi.fn>).mock.calls;
    expect(refunds.some(([, d]: [string, number]) => d > 0)).toBe(false); // org-billed: user pool untouched
    void users;
  });

  it('does NOT record an aborted event when no tokens were consumed', async () => {
    const { db, usageEvents } = buildDb();
    completeImpl = async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    };

    await expect(
      executeCompletion({
        ...baseParams,
        db,
        billingOrganizationId: 'org1',
        alwaysRecordUsage: true,
        serverTools: [makeServerTool('search_knowledge_base')],
      })
    ).rejects.toThrow(/aborted/i);

    expect(usageEvents.record).not.toHaveBeenCalled();
  });
});
