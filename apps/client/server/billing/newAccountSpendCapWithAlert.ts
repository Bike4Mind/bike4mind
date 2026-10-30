import { newAccountSpendCapAdapters } from '@bike4mind/database';
import type { creditService } from '@bike4mind/services';
import { alertFraudBlock } from '@server/billing/fraudBlockAlert';

/**
 * The deployed spend-cap adapters plus a LiveOps alert on each refusal. Every hold path in the apps
 * passes these rather than the bare database adapters.
 */
export const newAccountSpendCapAdaptersWithAlert: creditService.NewAccountSpendCapAdapters = {
  ...newAccountSpendCapAdapters,
  onRefused: ({ userId, refusal, requestedCredits }) =>
    alertFraudBlock({
      kind: 'newAccountSpendCap',
      userId,
      details: [
        `*Cap:* ${refusal.capCredits.toLocaleString('en-US')} credits per ${refusal.window}, ` +
          `${Math.ceil(refusal.spentCredits).toLocaleString('en-US')} spent, ` +
          `${Math.ceil(requestedCredits).toLocaleString('en-US')} requested`,
      ],
    }),
};
