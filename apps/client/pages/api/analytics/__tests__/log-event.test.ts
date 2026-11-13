// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  AiEvents,
  CreditPurchaseEvents,
  FirstRunEvents,
  MfaEnrollmentEvents,
  OrganizationEvents,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: (req: unknown, res: unknown) => unknown) => fn }),
}));

const mockLogEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({
  logEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

const { mockEmitProductEvent } = vi.hoisted(() => ({ mockEmitProductEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/analytics/emitActiveEvent', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/analytics/emitActiveEvent')>()),
  emitProductEvent: mockEmitProductEvent,
}));

import handler from '../log-event';
import { __resetQuestFeatureThrottle } from '@server/analytics/questFeature';
import { VISIT_COOKIE, mintVisitId } from '@server/analytics/visitSession';

const roundsPlayer = { id: 'user_1', isAdmin: false, tags: ['rounds'] };

function call(
  body: Record<string, unknown>,
  { user = { id: 'user_1' }, cookie }: { user?: object | null; cookie?: string } = {}
) {
  const { req, res } = createMocks({ method: 'POST', body, headers: cookie === undefined ? {} : { cookie } });
  Object.assign(req, { user: user ?? undefined, ability: {} });
  return { res, run: () => (handler as (r: unknown, s: unknown) => Promise<unknown>)(req, res) };
}

describe('POST /api/analytics/log-event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogEvent.mockResolvedValue(undefined);
    mockEmitProductEvent.mockResolvedValue(undefined);
    __resetQuestFeatureThrottle();
  });
  afterEach(() => vi.restoreAllMocks());

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
    FirstRunEvents.FIRST_ANSWER_CREDITS,
    FirstRunEvents.POLICIES_SHOWN,
    ...Object.values(MfaEnrollmentEvents),
    ...Object.values(OrganizationEvents),
  ])('refuses the server-only %s event', async type => {
    const { run } = call(
      { type, metadata: { paymentIntentId: 'pi_forged', amount: 999, credits: 500 } },
      { user: roundsPlayer }
    );

    await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockLogEvent).not.toHaveBeenCalled();
    expect(mockEmitProductEvent).not.toHaveBeenCalled();
  });

  describe('Rounds quest events', () => {
    it("forwards a Rounds player's recorded action to Overwatch as quest_feature_used", async () => {
      const visitId = mintVisitId();
      const { res, run } = call(
        { type: AiEvents.AI_GENERATE_IMAGE, metadata: {} },
        { user: roundsPlayer, cookie: `${VISIT_COOKIE}=${visitId}` }
      );

      await run();

      expect(mockEmitProductEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitProductEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          productId: 'bike4mind',
          event: 'quest_feature_used',
          userId: 'user_1',
          sessionId: visitId,
          metadata: { feature: 'ai_image_generated', internal: true },
        })
      );
      expect(mockLogEvent.mock.invocationCallOrder[0]).toBeLessThan(mockEmitProductEvent.mock.invocationCallOrder[0]);
      expect(res.statusCode).toBe(204);
    });

    it('forwards nothing for a user without Rounds access', async () => {
      const { res, run } = call({ type: AiEvents.AI_GENERATE_IMAGE, metadata: {} });

      await run();

      expect(mockLogEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitProductEvent).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(204);
    });

    it('forwards nothing for an anonymous call', async () => {
      const { run } = call({ type: AiEvents.AI_GENERATE_IMAGE, metadata: {} }, { user: null });

      await run();

      expect(mockEmitProductEvent).not.toHaveBeenCalled();
    });

    it('forwards nothing for an event the log refuses', async () => {
      mockLogEvent.mockRejectedValueOnce(new Error('Invalid counter event: Not A Type'));
      const { run } = call({ type: 'Not A Type', metadata: {} }, { user: roundsPlayer });

      await expect(run()).rejects.toThrow('Invalid counter event');
      expect(mockEmitProductEvent).not.toHaveBeenCalled();
    });

    it('sends a feature once per ten minutes, while every action is still recorded', async () => {
      await call({ type: AiEvents.AI_GENERATE_IMAGE, metadata: {} }, { user: roundsPlayer }).run();
      await call({ type: AiEvents.AI_GENERATE_IMAGE, metadata: {} }, { user: roundsPlayer }).run();

      expect(mockLogEvent).toHaveBeenCalledTimes(2);
      expect(mockEmitProductEvent).toHaveBeenCalledTimes(1);
    });

    it('answers once the emit has settled, so nothing runs on after the response', async () => {
      let settle = () => {};
      mockEmitProductEvent.mockReturnValueOnce(new Promise<void>(resolve => (settle = resolve)));
      const { res, run } = call({ type: AiEvents.AI_GENERATE_IMAGE, metadata: {} }, { user: roundsPlayer });

      const done = run();
      await vi.waitFor(() => expect(mockEmitProductEvent).toHaveBeenCalled());
      expect(res._isEndCalled()).toBe(false);

      settle();
      await done;
      expect(res._isEndCalled()).toBe(true);
      expect(res.statusCode).toBe(204);
    });

    it('still answers 204 when the emit fails', async () => {
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      mockEmitProductEvent.mockRejectedValueOnce(new Error('ingest down'));
      const { res, run } = call({ type: AiEvents.AI_GENERATE_IMAGE, metadata: {} }, { user: roundsPlayer });

      await run();
      expect(mockEmitProductEvent).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(204);
    });
  });
});
