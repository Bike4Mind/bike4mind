// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ construct: vi.fn(), find: vi.fn(), finish: vi.fn(), recordFailure: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (fn: unknown) => fn }) }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { STAGE: 'test', CARD_VERIFICATION_WEBHOOK_SECRET: 'whsec_synthetic' },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: { webhooks: { constructEvent: mocks.construct } },
}));
vi.mock('@server/billing/cardVerificationModel', () => ({
  CardVerification: { findOne: () => ({ lean: mocks.find }) },
}));
vi.mock('@server/billing/cardVerificationRuntime', () => ({
  finishCardVerification: mocks.finish,
  cardVerificationRuntime: async () => ({ guards: { recordFailure: mocks.recordFailure } }),
}));
import handler from '../card-verification-webhook';
import { CardVerificationRefused } from '@server/billing/cardVerificationLifecycle';
import { Config } from '@bike4mind/server-utils/utils/config';
const call = async () => {
  const { res } = createMocks();
  const req = {
    headers: { 'stripe-signature': 'synthetic-signature' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('synthetic-body');
    },
  };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
};
beforeEach(() => {
  vi.clearAllMocks();
  Config.CARD_VERIFICATION_WEBHOOK_SECRET = 'whsec_synthetic';
  mocks.find.mockResolvedValue({
    verificationId: 'synthetic-verification',
    userId: 'synthetic-user',
    environment: 'test',
  });
  mocks.construct.mockReturnValue({
    type: 'setup_intent.succeeded',
    livemode: false,
    data: { object: { id: 'seti_synthetic' } },
  });
});
describe('signed verification webhook', () => {
  it('refuses an unconfigured dedicated endpoint secret', async () => {
    Config.CARD_VERIFICATION_WEBHOOK_SECRET = '';
    expect((await call()).statusCode).toBe(503);
    expect(mocks.construct).not.toHaveBeenCalled();
  });
  it('rejects invalid signatures even on local development', async () => {
    mocks.construct.mockImplementation(() => {
      throw new Error('invalid');
    });
    expect((await call()).statusCode).toBe(400);
    expect(mocks.finish).not.toHaveBeenCalled();
  });
  it('completes only a server-bound verification', async () => {
    expect((await call()).statusCode).toBe(200);
    expect(mocks.construct).toHaveBeenCalledWith(
      Buffer.from('synthetic-body'),
      'synthetic-signature',
      'whsec_synthetic'
    );
    expect(mocks.finish).toHaveBeenCalledWith('synthetic-verification', 'synthetic-user');
  });
  it('acknowledges a refused completion so Stripe does not retry it', async () => {
    mocks.finish.mockRejectedValueOnce(new CardVerificationRefused('unavailable'));
    expect((await call()).statusCode).toBe(200);
    mocks.finish.mockRejectedValueOnce(new Error('synthetic outage'));
    await expect(call()).rejects.toThrow('synthetic outage');
  });
  it('ignores unknown or other-environment verifications', async () => {
    mocks.find.mockResolvedValue(null);
    await call();
    mocks.find.mockResolvedValue({ environment: 'other' });
    await call();
    expect(mocks.finish).not.toHaveBeenCalled();
  });
  it('records the signed failed attempt rather than a later mutable current attempt', async () => {
    const intent = { id: 'seti_synthetic', latest_attempt: 'setatt_old' };
    mocks.construct.mockReturnValue({ type: 'setup_intent.setup_failed', livemode: false, data: { object: intent } });
    await call();
    expect(mocks.recordFailure).toHaveBeenCalledWith(intent, expect.objectContaining({ userId: 'synthetic-user' }));
    expect(mocks.finish).not.toHaveBeenCalled();
  });
});
