import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';

const MODEL = 'triage-test-model';

const m = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  findEmail: vi.fn(),
  updateEmail: vi.fn(),
  existsForEmail: vi.fn(),
  storeForLiveEmail: vi.fn(),
  complete: vi.fn(),
  analyzeEmail: vi.fn(),
  sendEmail: vi.fn(),
  sendTestEmail: vi.fn(),
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() },
}));

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger:
    (handler: (event: SQSEvent, context: Context, logger: unknown) => Promise<void>) =>
    (event: SQSEvent, context: Context) =>
      handler(event, context, m.logger),
}));

// Outbound mail goes through this service; the analyzer and triage step must never reach it.
vi.mock('@bike4mind/server-utils/utils/mailer', () => {
  const mailer = { sendEmail: m.sendEmail, sendTestEmail: m.sendTestEmail };
  return { default: mailer, mailer };
});

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn(async (name: string) => m.settings[name]) },
  apiKeyRepository: {},
  usageEventRepository: {},
  organizationRepository: { findById: vi.fn() },
  ingestedEmailRepository: { findById: m.findEmail, update: m.updateEmail },
  User: { findById: vi.fn().mockResolvedValue({ id: 'user-1' }) },
  IngestedEmailModel: { countDocuments: vi.fn().mockResolvedValue(0) },
  emailTriageItemRepository: { existsForEmail: m.existsForEmail, storeForLiveEmail: m.storeForLiveEmail },
  assistantBriefRepository: { removeEmailSourcedItems: vi.fn() },
}));

vi.mock('@bike4mind/services', () => ({
  recordOperationalUsage: vi.fn().mockResolvedValue(undefined),
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({ anthropic: 'test' }) },
  emailAnalysisService: {
    emailDocumentToAnalysisInput: vi.fn((email: unknown) => email),
    analyzeEmail: m.analyzeEmail,
  },
}));

vi.mock('@bike4mind/utils', () => ({
  NotFoundError: class NotFoundError extends Error {},
  getSettingsByNames: vi.fn(),
}));

vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn().mockResolvedValue([{ id: 'triage-test-model', freeToRun: true }]),
  getLlmByModel: vi.fn(() => ({ complete: m.complete })),
}));

const { dispatch } = await import('./emailAnalyzer');

const storedEmail = () => ({
  _id: 'email-1',
  userId: 'user-1',
  from: 'vendor@example.com',
  to: ['me@example.com'],
  subject: 'Renewal',
  date: new Date('2026-11-17T09:00:00Z'),
  bodyText: 'Can you confirm the renewal date?',
});

const analysis = {
  summary: 'Vendor asks about the renewal date',
  sentiment: 'neutral',
  entities: { companies: [], people: [], products: [], technologies: [] },
  actionItems: [{ description: 'Confirm the date' }],
  suggestedTags: [],
  tokensUsed: { input: 100, output: 20 },
};

const triageReply = JSON.stringify({
  kind: 'decision',
  summary: 'Confirm the renewal date',
  draftReply: { body: 'Yes, the renewal is on the 1st.' },
});

const run = () =>
  (dispatch as unknown as (event: SQSEvent, context: Context) => Promise<void>)(
    { Records: [{ body: JSON.stringify({ emailId: 'email-1' }) }] } as SQSEvent,
    {} as Context
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.settings = { EnableEmailAnalysis: true, EnableEmailTriage: true, EmailAnalysisModel: MODEL };
  m.findEmail.mockResolvedValue(storedEmail());
  m.existsForEmail.mockResolvedValue(false);
  m.storeForLiveEmail.mockResolvedValue({ status: 'created' as const });
  m.analyzeEmail.mockResolvedValue(analysis);
  m.complete.mockImplementation(async (_model, _messages, _options, callback) => {
    await callback([triageReply], { inputTokens: 50, outputTokens: 10 });
  });
});

describe('emailAnalyzer dispatch with triage', () => {
  it('stores the drafted reply for review and sends nothing', async () => {
    await run();

    expect(m.updateEmail).toHaveBeenCalledOnce();
    expect(m.complete).toHaveBeenCalledOnce();
    expect(m.complete.mock.calls[0][2]).not.toHaveProperty('tools');
    expect(m.storeForLiveEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        emailId: 'email-1',
        kind: 'decision',
        draftReply: expect.objectContaining({ to: 'vendor@example.com', body: 'Yes, the renewal is on the 1st.' }),
      })
    );
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.sendTestEmail).not.toHaveBeenCalled();
  });

  it('does not triage again when the email was already analyzed', async () => {
    m.findEmail.mockResolvedValue({ ...storedEmail(), aiAnalysis: { summary: 'done' } });
    await run();

    expect(m.complete).not.toHaveBeenCalled();
    expect(m.storeForLiveEmail).not.toHaveBeenCalled();
  });

  it('skips the triage call when an item already exists for the email', async () => {
    m.existsForEmail.mockResolvedValue(true);
    await run();

    expect(m.complete).not.toHaveBeenCalled();
    expect(m.storeForLiveEmail).not.toHaveBeenCalled();
  });

  it('keeps the analysis and resolves when triage fails', async () => {
    m.complete.mockRejectedValue(new Error('model down'));
    await expect(run()).resolves.toBeUndefined();

    expect(m.updateEmail).toHaveBeenCalledOnce();
    expect(m.storeForLiveEmail).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it('makes no triage call while the setting is off', async () => {
    m.settings.EnableEmailTriage = false;
    await run();

    expect(m.updateEmail).toHaveBeenCalledOnce();
    expect(m.complete).not.toHaveBeenCalled();
  });
});
