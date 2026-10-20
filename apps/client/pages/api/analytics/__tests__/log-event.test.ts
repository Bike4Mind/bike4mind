// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CreditPurchaseEvents, FirstRunEvents } from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: (req: unknown, res: unknown) => unknown) => fn }),
}));

const mockLogEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/analyticsLog', () => ({
  logEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

import handler from '../log-event';

function call(body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'user_1' }, ability: {} });
  return { res, run: () => (handler as (r: unknown, s: unknown) => Promise<unknown>)(req, res) };
}

describe('POST /api/analytics/log-event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a client event against the caller', async () => {
    const { res, run } = call({
      type: CreditPurchaseEvents.PAYMENT_FORM_OPENED,
      metadata: { paymentIntentId: 'pi_1' },
    });

    await run();

    expect(mockLogEvent).toHaveBeenCalledWith(
      { type: CreditPurchaseEvents.PAYMENT_FORM_OPENED, metadata: { paymentIntentId: 'pi_1' }, userId: 'user_1' },
      expect.anything()
    );
    expect(res.statusCode).toBe(204);
  });

  it('writes a first-run event with its metadata', async () => {
    const { run } = call({ type: FirstRunEvents.SEND_BLOCKED, metadata: { reason: 'uploading' } });

    await run();

    expect(mockLogEvent).toHaveBeenCalledWith(
      { type: FirstRunEvents.SEND_BLOCKED, metadata: { reason: 'uploading' }, userId: 'user_1' },
      expect.anything()
    );
  });

  it.each([
    CreditPurchaseEvents.CHECKOUT_STARTED,
    CreditPurchaseEvents.CREDITS_GRANTED,
    CreditPurchaseEvents.CREDITS_ALREADY_GRANTED,
  ])('refuses the server-only %s event', async type => {
    const { run } = call({ type, metadata: { paymentIntentId: 'pi_forged', amount: 999, credits: 500 } });

    await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});
