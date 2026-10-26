import type { IUser, ThinkingVisibility } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { loadThinkingVisibilitySettings, resolveAccountThinkingVisibility } from '@bike4mind/services';
import { getActiveSubscriptionsForUser } from '@server/entitlements/activeSubscriptions';

type ThinkingVisibilityUser = Pick<IUser, 'isAdmin' | 'apiKeyTrustApproved' | 'lastCreditsPurchasedAt'> & {
  id: string;
};

/**
 * The caller's thinking visibility. Paid standing reads the same subscription rows as the API key
 * trust gate (apiKeyTrust.ts). Pass a user loaded from the database, never a client-supplied one.
 */
export async function resolveThinkingVisibility(user: ThinkingVisibilityUser): Promise<ThinkingVisibility> {
  const settings = await loadThinkingVisibilitySettings({ adminSettings: adminSettingsRepository });
  return resolveAccountThinkingVisibility(user, {
    settings,
    hasActivePlan: async () => (await getActiveSubscriptionsForUser(user.id)).length > 0,
  });
}
