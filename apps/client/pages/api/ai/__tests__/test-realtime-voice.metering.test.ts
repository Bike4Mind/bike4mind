// @vitest-environment node
/**
 * POST /api/ai/test-realtime-voice synthesizes with OpenAI tts-1-hd on the platform key, so it runs
 * the same credit gate as /api/ai/tts: a pre-flight before the provider call and a per-character
 * charge after. The real creditPreflight + deductTtsCredits run; only the stores are faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { computeTtsUsd, usdToCredits } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  enforce: true,
  balance: 1000,
  deduct: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (h: unknown) => h }) }));
vi.mock('@bike4mind/database', async () => ({
  ...(await import('@server/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  adminSettingsRepository: {},
  apiKeyRepository: {},
  usageEventRepository: { record: async () => undefined },
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: { findById: async () => ({ id: 'u1', currentCredits: m.balance }) },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => ({}),
  getSettingsValue: (name: string) => (name === 'enforceCredits' ? m.enforce : undefined),
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveApiKey: async () => 'sk-test' },
  creditService: { deductCreditsWithOrgSupport: m.deduct },
  organizationService: {},
  latchUsage: () => undefined,
}));
vi.mock('@bike4mind/services/llm/modelAdmission', () => ({}));
vi.mock('@bike4mind/services/cliCompletions', () => ({ estimateInputTokens: () => 0 }));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    audio = { speech: { create: m.create } };
  },
}));

const { default: handler } = await import('@pages/api/ai/test-realtime-voice');

const TEXT = 'Hello from the voice preview.';

async function call() {
  const { req, res } = createMocks({ method: 'POST', body: { text: TEXT } });
  Object.assign(req, { user: { id: 'u1' }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.balance = 1000;
  m.create.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(8) });
  m.deduct.mockResolvedValue(undefined);
});

describe('POST /api/ai/test-realtime-voice metering', () => {
  it('refuses a zero-credit caller with 422 and never calls the provider', async () => {
    m.balance = 0;

    const res = await call();

    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'insufficient_credits' });
    expect(m.create).not.toHaveBeenCalled();
  });

  it('charges a funded caller the priced characters once', async () => {
    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.deduct).toHaveBeenCalledOnce();
    expect(m.deduct).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'text_to_speech_usage',
        user: expect.objectContaining({ id: 'u1' }),
        organization: null,
        model: 'tts-1-hd',
        credits: usdToCredits(computeTtsUsd('openai', 'tts-1-hd', TEXT.length)),
      }),
      expect.anything()
    );
  });

  it('neither refuses nor charges when credits are not enforced', async () => {
    m.enforce = false;
    m.balance = 0;

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.create).toHaveBeenCalledOnce();
    expect(m.deduct).not.toHaveBeenCalled();
  });
});
