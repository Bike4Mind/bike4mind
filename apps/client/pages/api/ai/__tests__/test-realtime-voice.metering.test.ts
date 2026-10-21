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
  findOrg: vi.fn(),
  isMember: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (h: unknown) => h }) }));
vi.mock('@bike4mind/database', async () => ({
  ...(await import('@server/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  adminSettingsRepository: {},
  apiKeyRepository: {},
  usageEventRepository: { record: async () => undefined },
  creditTransactionRepository: {},
  organizationRepository: { findById: m.findOrg },
  userRepository: { findById: async () => ({ id: 'u1', currentCredits: m.balance }) },
}));
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    // Settlement rounds stochastically; draw 0 always rounds up so the charge is exact.
    usdToCreditsStochastic: (usd: number) => actual.usdToCreditsStochastic(usd, () => 0),
    getSettingsMap: async () => ({}),
    getSettingsValue: (name: string) => (name === 'enforceCredits' ? m.enforce : undefined),
  };
});
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveApiKey: async () => 'sk-test' },
  creditService: {
    deductCreditsWithOrgSupport: m.deduct,
    isMemberCreditCapExceeded: () => false,
  },
  organizationService: { isCurrentOrgMember: m.isMember },
  latchUsage: () => undefined,
}));
vi.mock('@bike4mind/services/llm/modelAdmission', () => ({}));
vi.mock('@bike4mind/services/cliCompletions', () => ({ estimateInputTokens: () => 0 }));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn() }));
vi.mock('@server/utils/orgAccess', () => ({ resolveBillingOrgId: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    audio = { speech: { create: m.create } };
  },
}));

const { default: handler } = await import('@pages/api/ai/test-realtime-voice');

const TEXT = 'Hello from the voice preview.';

async function call(extra: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'POST', body: { text: TEXT } });
  Object.assign(req, { ...extra, user: { id: 'u1' }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.balance = 1000;
  m.findOrg.mockResolvedValue({ id: 'o1', currentCredits: 1000 });
  m.isMember.mockReturnValue(true);
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

  it('checks and charges the org pool for an organization-owned API key', async () => {
    m.balance = 0;
    const org = { id: 'o1', currentCredits: 1000 };
    m.findOrg.mockResolvedValue(org);

    const res = await call({ apiKeyInfo: { billingOwnerType: 'Organization', organizationId: 'o1' } });

    expect(res._getStatusCode()).toBe(200);
    expect(m.deduct).toHaveBeenCalledWith(expect.objectContaining({ organization: org }), expect.anything());
    expect(m.isMember).toHaveBeenCalledWith(org, 'u1');
  });

  it('refuses an org key whose holder has left before calling the provider', async () => {
    m.isMember.mockReturnValue(false);

    await expect(call({ apiKeyInfo: { billingOwnerType: 'Organization', organizationId: 'o1' } })).rejects.toThrow(
      'no longer a member'
    );

    expect(m.create).not.toHaveBeenCalled();
    expect(m.deduct).not.toHaveBeenCalled();
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
