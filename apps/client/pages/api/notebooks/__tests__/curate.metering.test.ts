// @vitest-environment node
/**
 * POST /api/notebooks/curate enqueues work whose executive summary runs on the platform key, so a
 * caller who cannot pay is refused (422) before any curation job is published.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({ assertOwnerCanAfford: vi.fn(), publish: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (h: unknown) => h }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (h: unknown) => h }));
vi.mock('@server/billing/meterPlatformCompletion', () => ({ assertOwnerCanAfford: m.assertOwnerCanAfford }));
vi.mock('@server/utils/eventBus', () => ({ NotebookCurationEvents: { Start: { publish: m.publish } } }));
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: async (id: string) => ({ id, userId: 'u1' }) },
}));

const { default: handler } = await import('@pages/api/notebooks/curate');

const SESSION = 'a'.repeat(24);

async function call(curationType: string) {
  const { req, res } = createMocks({ method: 'POST', body: { sessionIds: [SESSION], curationType } });
  Object.assign(req, { user: { id: 'u1' }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.assertOwnerCanAfford.mockResolvedValue(undefined);
});

describe('POST /api/notebooks/curate metering', () => {
  it('refuses an executive summary for a caller who cannot pay, before publishing any job', async () => {
    m.assertOwnerCanAfford.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call('executive_summary')).rejects.toMatchObject({ statusCode: 422 });
    expect(m.publish).not.toHaveBeenCalled();
  });

  it('enqueues a funded executive summary', async () => {
    const res = await call('executive_summary');
    expect(res._getStatusCode()).toBe(202);
    expect(m.publish).toHaveBeenCalledOnce();
  });

  it('does not gate a transcript, which makes no LLM call', async () => {
    const res = await call('transcript');
    expect(res._getStatusCode()).toBe(202);
    expect(m.assertOwnerCanAfford).not.toHaveBeenCalled();
  });
});
