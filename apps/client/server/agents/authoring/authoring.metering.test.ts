// @vitest-environment node
/**
 * The authoring helpers bill their text completion through the meter their route hands them: the
 * meter runs with the model before the provider is called, and a refusal stops the call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  complete: vi.fn(),
  meter: vi.fn(),
}));

const MODEL = { id: 'claude-haiku-4-5-20251001', backend: 'anthropic', pricing: {} };

vi.mock('@bike4mind/database', () => ({
  agentRepository: { update: async () => ({ id: 'a1' }) },
  agentOpsSettingsRepository: {
    getSettings: async () => ({ isEnabled: true, rateLimitSeconds: 0, generationLlmModel: MODEL.id }),
    createOrUpdateSettings: async () => undefined,
    getActiveMetaPrompt: async () => ({ content: 'meta' }),
  },
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsByNames: async () => ({}),
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: async () => [MODEL],
  getLlmByModel: () => ({ complete: m.complete }),
}));
// Same contract as the real wrapper: reserve through the meter, then run the provider.
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) },
  meterCompletionBackend: (
    llm: { complete: (...args: unknown[]) => unknown },
    meter: (info: unknown) => Promise<unknown>,
    info: unknown
  ) => ({
    complete: async (...args: unknown[]) => {
      await meter(info);
      return llm.complete(...args);
    },
  }),
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({ modelId: MODEL.id, modelInfo: MODEL, llm: { complete: m.complete } }),
  },
}));
vi.mock('@server/agents/systemPromptRateLimit', () => ({ assertSystemPromptGenerationAllowed: vi.fn() }));

const { enhanceAgentField } = await import('./enhanceAgentField');
const { generateAgentDescription } = await import('./generateAgentDescription');
const { generateAgentSystemPrompt } = await import('./generateAgentSystemPrompt');

const agent = { id: 'a1', name: 'Ada' } as never;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } as never;

const RUNS: Array<[string, (meter: typeof m.meter) => Promise<string>]> = [
  [
    'enhanceAgentField',
    meter => enhanceAgentField(agent, 'u1', { fieldName: 'personalMission', currentValue: 'x' }, logger, meter),
  ],
  ['generateAgentDescription', meter => generateAgentDescription(agent, logger, meter)],
  ['generateAgentSystemPrompt', meter => generateAgentSystemPrompt(agent, 'u1', logger, meter)],
];

beforeEach(() => {
  vi.clearAllMocks();
  m.meter.mockResolvedValue({});
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb(['generated text']);
  });
});

describe.each(RUNS)('%s metering', (_name, run) => {
  it('runs the meter with the model before the provider call', async () => {
    await expect(run(m.meter)).resolves.toBe('generated text');

    expect(m.meter).toHaveBeenCalledWith(MODEL);
    expect(m.meter).toHaveBeenCalledBefore(m.complete);
  });

  it('never calls the provider when the meter refuses', async () => {
    m.meter.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(run(m.meter)).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
  });
});
