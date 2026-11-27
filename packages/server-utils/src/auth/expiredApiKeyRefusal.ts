import { toAbsoluteUrl, UnauthorizedError } from '@bike4mind/common';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';

/** Where an owner replaces an expired MCP key. Shared with the expiry reminder email. */
export const API_KEY_RENEWAL_PATH = '/profile?tab=api-keys';

/** Absolute renewal link when the deployment knows its app URL, else the bare path. */
export const apiKeyRenewalUrl = (appUrl: string | undefined = process.env.APP_URL?.trim()): string =>
  appUrl ? (toAbsoluteUrl(appUrl, API_KEY_RENEWAL_PATH) ?? API_KEY_RENEWAL_PATH) : API_KEY_RENEWAL_PATH;

/**
 * When the presented key is the full secret of an expired MCP key, answer with `api_key_expired` and a
 * renewal link instead of a bare "Invalid API key". Only a caller holding the secret learns this.
 * Best-effort like refuseIfSuspendedOwner: a failed lookup keeps the plain 401.
 */
export async function refuseIfExpiredMcpKey(apiKey: string, logger?: { warn(msg: string, meta?: unknown): void }) {
  let expired = false;
  try {
    expired = await userApiKeyService.isExpiredExplicitScopeOnlyKey(apiKey, {
      db: { userApiKeys: userApiKeyRepository },
    });
  } catch (error) {
    logger?.warn('Expired-key lookup for a refused API key failed', { error: String(error) });
    return;
  }
  if (expired)
    throw new UnauthorizedError('API key expired', { code: 'api_key_expired', renew_url: apiKeyRenewalUrl() });
}
