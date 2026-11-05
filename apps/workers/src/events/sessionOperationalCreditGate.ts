import type { Logger } from '@bike4mind/observability';
import { checkSessionOperationalCredits } from '@server/utils/sessionOperationalCreditPreflight';

/**
 * Balance gate for the session event handlers (auto-naming, summarization, tagging, context
 * summarization, mementos), run right before their operations-model call.
 *
 * Most of these events are published downstream of a chat turn, and that turn's settlement can
 * leave the payer at exactly zero (the balance cap floors it there). The handler's charge settles
 * after the call through `recordOperationalUsage`, which never checks the balance, so without this
 * gate a zero-balance payer is pushed negative by the follow-up work. The request-side pre-flight
 * (`apps/client/server/utils/sessionOperationalCreditPreflight`) only guards the routes that
 * publish these events directly; this covers every publisher, including future ones.
 *
 * Returns false to skip the work. An unexpected failure also skips: the work is a non-critical
 * convenience, and skipping it cannot cost the payer anything.
 */
export async function payerCanFundSessionOperation({
  payerId,
  operation,
  logger,
}: {
  payerId: string;
  operation: string;
  logger: Logger;
}): Promise<boolean> {
  try {
    const verdict = await checkSessionOperationalCredits({ userId: payerId, operationCount: 1, operation, logger });
    if (verdict.allowed) return true;
    logger.info(`[SESSION_OP_CREDIT_SKIP] skipping ${operation}; payer cannot cover it`, {
      payerId,
      reason: verdict.reason,
    });
    return false;
  } catch (err) {
    logger.error(`[SESSION_OP_CREDIT_SKIP] credit check failed; skipping ${operation}`, err, { payerId });
    return false;
  }
}
