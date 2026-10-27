import type { IUser, ThinkingVisibility } from '@bike4mind/common';
import { adminSettingsRepository, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import {
  fallbackThinkingVisibility,
  loadThinkingVisibilitySettings,
  resolveAccountThinkingVisibility,
  type ThinkingVisibilitySettings,
} from '@bike4mind/services';
import { getActiveSubscriptionsForUser } from '@server/entitlements/activeSubscriptions';
import { persistedIsAdmin } from '@server/auth/apiKeyAdminScope';

type ThinkingVisibilityUser = Pick<IUser, 'isAdmin' | 'apiKeyTrustApproved' | 'lastCreditsPurchasedAt'> & {
  id: string;
};

/**
 * The caller's thinking visibility. Paid standing reads the same subscription rows as the API key
 * trust gate (apiKeyTrust.ts) and the stored admin role, which an API key without the admin scope
 * hides from `isAdmin`. Never throws: a failed lookup gets the free level, or `summary` without
 * settings. Pass a user loaded from the database, never a client-supplied one.
 */
export async function resolveThinkingVisibility(user: ThinkingVisibilityUser): Promise<ThinkingVisibility> {
  let settings: ThinkingVisibilitySettings;
  try {
    settings = await loadThinkingVisibilitySettings({ adminSettings: adminSettingsRepository });
  } catch (error) {
    Logger.globalInstance.warn('[thinkingVisibility] settings unavailable; using summary', { userId: user.id, error });
    return 'summary';
  }
  try {
    return await resolveAccountThinkingVisibility(
      {
        isAdmin: persistedIsAdmin(user),
        apiKeyTrustApproved: user.apiKeyTrustApproved,
        lastCreditsPurchasedAt: user.lastCreditsPurchasedAt,
      },
      { settings, hasActivePlan: async () => (await getActiveSubscriptionsForUser(user.id)).length > 0 }
    );
  } catch (error) {
    Logger.globalInstance.warn('[thinkingVisibility] tier lookup failed; using the free level', {
      userId: user.id,
      error,
    });
    return settings.free;
  }
}

/** For hosts that hold only the account id (deep agent wakes). */
export async function resolveThinkingVisibilityForUserId(userId: string): Promise<ThinkingVisibility> {
  const user = await userRepository.findById(userId).catch(() => null);
  return user
    ? resolveThinkingVisibility(user)
    : fallbackThinkingVisibility({ adminSettings: adminSettingsRepository });
}
