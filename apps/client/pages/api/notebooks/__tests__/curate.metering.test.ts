// @vitest-environment node
/**
 * POST /api/notebooks/curate enqueues work whose executive summary runs on the platform key, so a
 * caller who cannot pay is refused (422) before any curation job is published.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CreditHolderType, insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({ assertRequestCanAfford: vi.fn(), publish: vi.fn(), admit: vi.fn() }));

vi.mock('@server/utils/untrustedCompletionQuota', () => ({ admitRequestCompletion: m.admit }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (h: unknown) => h }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (h: unknown) => h }));
vi.mock('@server/billing/meterPlatformCompletion', () => ({ assertRequestCanAfford: m.assertRequestCanAfford }));
vi.mock('@server/utils/eventBus', () => ({ NotebookCurationEvents: { Start: { publish: m.publish } } }));
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: async (id: string) => ({ id, userId: 'u1' }) },
}));

const { default: handler } = await import('@pages/api/notebooks/curate');

const SESSION = 'a'.repeat(24);

async function call(curationType: string, apiKeyInfo?: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body: { sessionIds: [SESSION], curationType } });
  Object.assign(req, {
    user: { id: 'u1', organizationId: 'home-org' },
    apiKeyInfo,
    headers: { 'user-agent': 'b4m-cli/1.0' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.assertRequestCanAfford.mockResolvedValue(undefined);
});

describe('POST /api/notebooks/curate metering', () => {
  it('refuses an over-quota executive summary before publishing', async () => {
    const error = new Error('token quota exceeded');
    m.admit.mockRejectedValueOnce(error);

    await expect(call('executive_summary', { keyId: 'personal-key' })).rejects.toBe(error);
    expect(m.admit).toHaveBeenCalledWith(expect.objectContaining({ apiKeyInfo: { keyId: 'personal-key' } }), {
      holdSlot: false,
    });
    expect(m.assertRequestCanAfford).not.toHaveBeenCalled();
    expect(m.publish).not.toHaveBeenCalled();
  });
  it('refuses an executive summary for a caller who cannot pay, before publishing any job', async () => {
    m.assertRequestCanAfford.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call('executive_summary')).rejects.toMatchObject({ statusCode: 422 });
    expect(m.publish).not.toHaveBeenCalled();
  });

  it('enqueues a funded executive summary', async () => {
    const res = await call('executive_summary');
    expect(res._getStatusCode()).toBe(202);
    expect(m.publish).toHaveBeenCalledOnce();
  });

  it.each([
    { billingOwnerType: CreditHolderType.User, organizationId: undefined, expectedOrganizationId: null },
    { billingOwnerType: CreditHolderType.Organization, organizationId: 'key-org', expectedOrganizationId: 'key-org' },
  ])('retains the API key payer for $billingOwnerType billed summaries', async payer => {
    await call('executive_summary', { keyId: 'key-1', ...payer });

    expect(m.assertRequestCanAfford).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyInfo: expect.objectContaining({ keyId: 'key-1' }) })
    );
    expect(m.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        billing: { organizationId: payer.expectedOrganizationId, apiKeyId: 'key-1', source: 'cli' },
      }),
      { requireAcceptance: true }
    );
  });

  it('captures a JWT caller home organization before the worker runs', async () => {
    await call('executive_summary');

    expect(m.publish).toHaveBeenCalledWith(expect.objectContaining({ billing: { organizationId: 'home-org' } }), {
      requireAcceptance: true,
    });
  });

  it('does not gate a transcript, which makes no LLM call', async () => {
    const res = await call('transcript');
    expect(res._getStatusCode()).toBe(202);
    expect(m.assertRequestCanAfford).not.toHaveBeenCalled();
    expect(m.admit).not.toHaveBeenCalled();
  });
});
