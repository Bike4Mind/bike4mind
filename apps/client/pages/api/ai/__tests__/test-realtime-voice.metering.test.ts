import { createModelAdmission } from '@bike4mind/services/llm/modelAdmission';
// @vitest-environment node
/**
 * POST /api/ai/test-realtime-voice synthesizes with OpenAI tts-1-hd on the platform key, so it runs
 * the same credit gate as /api/ai/tts: a pre-flight before the provider call and a per-character
 * charge after. The real creditPreflight + deductTtsCredits run; only the stores are faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { computeTtsUsd, usdToCredits } from '@bike4mind/common';
import { holdPreflightCredits } from '@server/utils/creditPreflight';
import { deductTtsCredits } from '@server/utils/deductTtsCredits';

const m = vi.hoisted(() => ({
  enforce: true,
  balance: 1000,
  deduct: vi.fn(),
  create: vi.fn(),
  findOrg: vi.fn(),
  isMember: vi.fn(),
  userIncrement: vi.fn(),
  orgIncrement: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock('@server/utils/creditPreflight', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/creditPreflight')>();
  return { ...actual, holdPreflightCredits: vi.fn(actual.holdPreflightCredits) };
});
vi.mock('@server/utils/deductTtsCredits', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/deductTtsCredits')>();
  return { ...actual, deductTtsCredits: vi.fn(actual.deductTtsCredits) };
});

vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (h: unknown) => h }) }));
vi.mock('@bike4mind/database', async () => ({
  ...(await import('@server/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  adminSettingsRepository: {},
  apiKeyRepository: {},
  usageEventRepository: { record: m.recordUsage },
  creditTransactionRepository: {},
  organizationRepository: { findById: m.findOrg, incrementCredits: m.orgIncrement },
  userRepository: {
    findById: async () => ({ id: 'u1', currentCredits: m.balance }),
    incrementCredits: m.userIncrement,
  },
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
vi.mock('@bike4mind/services', async () => ({
  apiKeyService: { getEffectiveApiKey: async () => 'sk-test' },
  creditService: {
    ...(await vi.importActual<typeof import('@bike4mind/services/creditService')>('@bike4mind/services/creditService')),
    deductCreditsWithOrgSupport: m.deduct,
    isMemberCreditCapExceeded: () => false,
  },
  organizationService: { isCurrentOrgMember: m.isMember },
  latchUsage: () => undefined,
}));
vi.mock('@bike4mind/services/llm/modelAdmission', () => ({
  createModelAdmission: vi.fn(() => ({ assert: async () => {}, admits: async () => true })),
  loadModelConfigurations: async () => [],
  loadFreeTierAllowedModels: async () => undefined,
}));
vi.mock('@bike4mind/services/cliCompletions', () => ({ estimateInputTokens: () => 0 }));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({ resolveBillingOrgId: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    audio = { speech: { create: m.create } };
  },
}));

const { default: handler } = await import('@pages/api/ai/test-realtime-voice');

const TEXT = 'Hello from the voice preview.';

async function call(extra: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'POST', body: { text: TEXT } });
  Object.assign(req, { user: { id: 'u1' }, ...extra, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
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
  m.recordUsage.mockResolvedValue(undefined);
  m.userIncrement.mockImplementation(async (_id: string, delta: number) => ({
    id: 'u1',
    currentCredits: (m.balance += delta),
  }));
  m.orgIncrement.mockResolvedValue({ id: 'o1', currentCredits: 900 });
});

describe('POST /api/ai/test-realtime-voice metering', () => {
  it('refuses paid-only preview speech before the hold and provider', async () => {
    const refusal = new Error('paid plan required');
    const assertAdmission = vi.fn(async (_modelId: string) => {
      throw refusal;
    });
    vi.mocked(createModelAdmission).mockReturnValueOnce({ assert: assertAdmission, admits: async () => false });
    await expect(call()).rejects.toBe(refusal);
    expect(createModelAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'u1' }) })
    );
    expect(assertAdmission).toHaveBeenCalledWith('tts-1-hd');
    expect(holdPreflightCredits).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

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
    expect(m.userIncrement).toHaveBeenCalledWith('u1', -usdToCredits(computeTtsUsd('openai', 'tts-1-hd', TEXT.length)));
    const acquired = await vi.mocked(holdPreflightCredits).mock.results[0].value;
    expect(vi.mocked(deductTtsCredits).mock.calls[0][0].hold).toBe(acquired);
    expect(m.deduct).toHaveBeenCalledOnce();
    expect(m.deduct).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'text_to_speech_usage',
        user: expect.objectContaining({ id: 'u1' }),
        organization: null,
        model: 'tts-1-hd',
        credits: usdToCredits(computeTtsUsd('openai', 'tts-1-hd', TEXT.length)),
      }),
      expect.anything(),
      expect.objectContaining({ skipBalanceUpdate: true })
    );
  });

  it('keeps a user-billed key on the user despite their org seat', async () => {
    const res = await call({
      user: { id: 'u1', organizationId: 'o1' },
      apiKeyInfo: { billingOwnerType: 'User', organizationId: 'o1' },
    });

    expect(res._getStatusCode()).toBe(200);
    expect(m.userIncrement).toHaveBeenCalledWith('u1', -usdToCredits(computeTtsUsd('openai', 'tts-1-hd', TEXT.length)));
    expect(m.orgIncrement).not.toHaveBeenCalled();
    expect(m.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'u1', ownerType: 'User' }));
  });

  it('checks and charges the org pool for an organization-owned API key', async () => {
    m.balance = 0;
    const org = { id: 'o1', currentCredits: 1000 };
    m.findOrg.mockResolvedValue(org);

    const res = await call({ apiKeyInfo: { billingOwnerType: 'Organization', organizationId: 'o1' } });

    expect(res._getStatusCode()).toBe(200);
    expect(m.deduct).toHaveBeenCalledWith(
      expect.objectContaining({ organization: org }),
      expect.anything(),
      expect.objectContaining({ skipBalanceUpdate: true })
    );
    expect(m.isMember).toHaveBeenCalledWith(org, 'u1');
    expect(m.orgIncrement).toHaveBeenCalledWith('o1', -usdToCredits(computeTtsUsd('openai', 'tts-1-hd', TEXT.length)));
    expect(m.userIncrement).not.toHaveBeenCalled();
    expect(m.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'o1', ownerType: 'Organization' }));
  });

  it('refuses an org key whose holder has left before calling the provider', async () => {
    m.isMember.mockReturnValue(false);

    await expect(call({ apiKeyInfo: { billingOwnerType: 'Organization', organizationId: 'o1' } })).rejects.toThrow(
      'no longer a member'
    );

    expect(m.create).not.toHaveBeenCalled();
    expect(m.deduct).not.toHaveBeenCalled();
  });

  it('keeps the successful synthesis charged when reading its audio fails', async () => {
    m.create.mockResolvedValue({
      arrayBuffer: async () => {
        throw new Error('body read failed');
      },
    });

    const res = await call();

    expect(res._getStatusCode()).toBe(500);
    expect(m.userIncrement.mock.calls).toEqual([
      ['u1', -usdToCredits(computeTtsUsd('openai', 'tts-1-hd', TEXT.length))],
    ]);
    expect(m.deduct).toHaveBeenCalledOnce();
  });

  it('refunds the same org hold when synthesis fails', async () => {
    m.create.mockRejectedValue(new Error('provider unavailable'));

    const res = await call({ apiKeyInfo: { billingOwnerType: 'Organization', organizationId: 'o1' } });

    const credits = usdToCredits(computeTtsUsd('openai', 'tts-1-hd', TEXT.length));
    expect(res._getStatusCode()).toBe(500);
    expect(m.orgIncrement.mock.calls).toEqual([
      ['o1', -credits],
      ['o1', credits],
    ]);
    expect(m.userIncrement).not.toHaveBeenCalled();
    expect(m.deduct).not.toHaveBeenCalled();
  });

  it('neither refuses nor charges when credits are not enforced', async () => {
    m.enforce = false;
    m.balance = 0;

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.create).toHaveBeenCalledOnce();
    expect(m.deduct).not.toHaveBeenCalled();
    expect(m.userIncrement).not.toHaveBeenCalled();
    expect(m.orgIncrement).not.toHaveBeenCalled();
  });
});
