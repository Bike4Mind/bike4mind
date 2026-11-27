import { API_KEY_EXPIRED_ERROR_CODE } from './apiErrorCodes';
import { UnauthorizedError } from './errors';

/** The `renewal` member of an `api_key_expired` body. */
export type ApiKeyRenewalDetail = { renew_url: string };

/**
 * The 401 a valid secret of an expired MCP key gets, so a client can tell it from an unknown key and send
 * the owner to mint a replacement: `errorCode: api_key_expired` per CONVENTIONS.md. The renewal link is
 * omitted when the deployment has no app URL, rather than published relative.
 */
export function apiKeyExpiredError(renewUrl?: string): UnauthorizedError {
  const renewal: ApiKeyRenewalDetail | undefined = renewUrl ? { renew_url: renewUrl } : undefined;
  return new UnauthorizedError('API key expired', {
    errorCode: API_KEY_EXPIRED_ERROR_CODE,
    ...(renewal && { renewal }),
  });
}
