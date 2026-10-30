import {
  adminSettingsRepository,
  usageEventRepository,
  userApiKeyRepository,
  userRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';

/**
 * userService.refreshSignupRiskScore wired to the app's repositories. Called after signup, email
 * verification and API key creation; never throws.
 */
export function refreshSignupRiskScore(userId: string, logger: Pick<Logger, 'warn'>): Promise<void> {
  return userService.refreshSignupRiskScore(userId, {
    db: {
      users: userRepository,
      userApiKeys: userApiKeyRepository,
      usageEvents: usageEventRepository,
      adminSettings: adminSettingsRepository,
    },
    logger,
  });
}
