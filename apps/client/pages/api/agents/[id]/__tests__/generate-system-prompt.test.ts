import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  update: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return {};
    },
  }),
}));
vi.mock('@bike4mind/database', () => ({
  agentRepository: { findById: h.findById, update: h.update },
  agentOpsSettingsRepository: {
    getSettings: vi.fn().mockResolvedValue(null),
    getActiveMetaPrompt: vi.fn().mockResolvedValue({ content: 'meta' }),
    createOrUpdateSettings: vi.fn(),
  },
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn().mockResolvedValue([{ id: 'claude-opus-4-20250514' }]),
  getLlmByModel: () => ({ complete: h.complete }),
}));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) } }));
vi.mock('@client/server/agents/systemPromptRateLimit', () => ({ assertSystemPromptGenerationAllowed: vi.fn() }));

await import('../generate-system-prompt');

describe('POST /api/agents/[id]/generate-system-prompt', () => {
  beforeEach(() => {
    h.update.mockReset();
    h.complete.mockReset();
  });

  it('writes exactly the trimmed prompt and generation timestamp', async () => {
    h.findById.mockResolvedValue({ id: 'agent-1', userId: 'user-1', name: 'A' });
    h.update.mockResolvedValue({ id: 'agent-1' });
    h.complete.mockImplementation(
      async (_m: unknown, _msgs: unknown, _o: unknown, cb: (t: string[]) => Promise<void>) => {
        await cb(['  prompt  ']);
      }
    );
    const json = vi.fn();

    await h.handler!(
      { query: { id: 'agent-1' }, user: { id: 'user-1' }, logger: { info: vi.fn(), error: vi.fn() } },
      { json, status: vi.fn().mockReturnThis() }
    );

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({
      id: 'agent-1',
      systemPrompt: 'prompt',
      lastSystemPromptGeneratedAt: expect.any(Date),
    });
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, systemPrompt: 'prompt' }));
  });
});
