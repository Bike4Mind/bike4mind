// @vitest-environment node
/**
 * generateAgentAvatar bills its text-prompt completion through the meter its route hands it: the meter
 * runs with the operations model before the provider is called, and a refusal stops the call. The image
 * reservation is separate and is not touched before the prompt is generated.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  complete: vi.fn(),
  meter: vi.fn(),
  reserveRequestCredits: vi.fn(),
}));

const TEXT_MODEL = { id: 'text-model', backend: 'anthropic', pricing: {} };

vi.mock('@server/billing/reserveRequestCredits', () => ({ reserveRequestCredits: m.reserveRequestCredits }));
vi.mock('@server/billing/assertMediaModelAdmission', () => ({ assertMediaModelAdmission: async () => undefined }));
vi.mock('@bike4mind/services/imageCost', () => ({ estimateImageCredits: () => ({ requiredCredits: 1, usdCost: 0 }) }));
vi.mock('@bike4mind/database', () => ({
  agentRepository: {},
  apiKeyRepository: {},
  adminSettingsRepository: {},
  fabFileRepository: {},
}));
vi.mock('@bike4mind/llm-adapters', () => ({ getAvailableModels: async () => [] }));
vi.mock('@bike4mind/services/llm/imageModerationGate', () => ({ moderateImageOrThrow: vi.fn() }));
vi.mock('@server/moderation/imageModerationIncidents', () => ({ imageModerationIncidents: {} }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({
      modelId: TEXT_MODEL.id,
      modelInfo: TEXT_MODEL,
      llm: { complete: m.complete },
      imageModelId: 'image-model',
      imageModelInfo: { backend: 'openai' },
    }),
  },
}));
// Same contract as the real wrapper: reserve through the meter, then run the provider.
vi.mock('@bike4mind/services', () => ({
  apiKeyService: {},
  fabFilesService: {},
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

const { generateAgentAvatar } = await import('./generateAgentAvatar');

const agent = { id: 'a1', name: 'Ada' } as never;
const user = { id: 'u1', isAdmin: false } as never;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } as never;
const run = () => generateAgentAvatar(agent, user, undefined, logger, undefined, m.meter);

beforeEach(() => {
  vi.clearAllMocks();
  m.meter.mockResolvedValue({});
  // An empty prompt ends the run right after the completion, before any image work.
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb([null]);
  });
});

describe('generateAgentAvatar prompt metering', () => {
  it('runs the meter with the operations model before the provider call', async () => {
    await expect(run()).rejects.toThrow('Failed to generate visual prompt');

    expect(m.meter).toHaveBeenCalledWith(TEXT_MODEL);
    expect(m.meter).toHaveBeenCalledBefore(m.complete);
    expect(m.reserveRequestCredits).not.toHaveBeenCalled();
  });

  it('never calls the provider when the meter refuses', async () => {
    m.meter.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(run()).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
  });
});
