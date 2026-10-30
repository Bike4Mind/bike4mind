import { newAccountSpendCapAdapters } from '@bike4mind/database';
import type { creditService } from '@bike4mind/services';

/**
 * The deployed spend-cap adapters plus a LiveOps alert on each refusal. Every hold path in the apps
 * passes these rather than the bare database adapters. They delegate on use rather than spreading at
 * import, so a module that only imports a hold path does not read the database adapters.
 */
export const newAccountSpendCapAdaptersWithAlert: creditService.NewAccountSpendCapAdapters = {
  get adminSettings() {
    return newAccountSpendCapAdapters.adminSettings;
  },
  personalSpendSince: (userId, since) => newAccountSpendCapAdapters.personalSpendSince(userId, since),
  // Loaded on first refusal: the Slack module reads deploy config at import, and every hold path
  // (and every suite that imports one) would otherwise pull it in.
  onRefused: async ({ userId, refusal, requestedCredits }) => {
    const { alertFraudBlock } = await import('@server/billing/fraudBlockAlert');
    await alertFraudBlock({
      kind: 'newAccountSpendCap',
      userId,
      details: [
        `*Cap:* ${refusal.capCredits.toLocaleString('en-US')} credits per ${refusal.window}, ` +
          `${Math.ceil(refusal.spentCredits).toLocaleString('en-US')} spent, ` +
          `${Math.ceil(requestedCredits).toLocaleString('en-US')} requested`,
      ],
    });
  },
};
