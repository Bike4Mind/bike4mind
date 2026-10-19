// any: vitest mock shapes; test files are not typechecked
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatch } from './whatsNewHighlights';
import { AdminSettings, ModalModel, connectDB } from '@bike4mind/database';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { apiKeyService } from '@bike4mind/services';

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  ModalModel: { find: vi.fn() },
  AdminSettings: { findOne: vi.fn(), findOneAndUpdate: vi.fn() },
  slackDevWorkspaceRepository: {},
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn() },
}));

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return { ...actual, getAvailableModels: vi.fn(), getLlmByModel: vi.fn() };
});

vi.mock('@server/utils/cloudwatch', () => ({
  emitModalGenerationMetrics: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/security/tokenEncryption', () => ({ decryptToken: vi.fn() }));

// The model gate runs after the release-note fetch; stub the fetch so these cases isolate the gate.
vi.mock('@server/whatsNew/releaseNoteHighlights', () => ({
  loadHighlightsReleaseNotes: vi.fn().mockResolvedValue({
    kind: 'ok',
    truncated: false,
    entries: [
      {
        _id: 'm1',
        title: 'T',
        subtitle: 'S',
        description: 'D',
        createdAt: new Date('2026-02-07T10:00:00Z'),
      },
    ],
  }),
}));

describe('whatsNewHighlights configured model validation', () => {
  const context = {} as Parameters<typeof dispatch>[1];
  const event = {
    Records: [{ body: JSON.stringify({ correlationId: 'c1', environment: 'dev' }) }],
  } as unknown as Parameters<typeof dispatch>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    (connectDB as any).mockResolvedValue(undefined);
  });

  it.each([
    ['gpt-5.4-mini-2026-03-17', 'gpt-4o-mini'],
    ['gpt-5.4-mini', 'gpt-5.4-mini'],
  ])('configured model %s resolves to %s', async (configured, expected) => {
    (AdminSettings.findOne as any).mockResolvedValue({ settingValue: { llmModel: configured } });
    (ModalModel.find as any).mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      lean: vi
        .fn()
        .mockResolvedValue([
          { _id: 'm1', title: 'T', subtitle: 'S', description: 'D', createdAt: new Date('2026-02-07T10:00:00Z') },
        ]),
    });
    (apiKeyService.getEffectiveLLMApiKeys as any).mockResolvedValue({});
    // Both ids are listed, so only the servable-model check can send the snapshot to the default.
    (getAvailableModels as any).mockResolvedValue(
      [configured, 'gpt-4o-mini'].map(id => ({ id, name: id, backend: 'test', type: 'text' }))
    );
    const complete = vi.fn().mockImplementation(async (_id, _messages, _options, callback) => {
      await callback(['highlights']);
    });
    (getLlmByModel as any).mockReturnValue({ complete });

    await dispatch(event, context);

    expect(complete).toHaveBeenCalledWith(expected, expect.anything(), expect.anything(), expect.any(Function));
  });
});
