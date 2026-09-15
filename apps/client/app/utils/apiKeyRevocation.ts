import { ApiKeyStatus, IUserApiKey } from '@bike4mind/common';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

/**
 * `IUserApiKey` types these as `Date`, but the client reads them out of a JSON
 * response, so at runtime they arrive as ISO strings. dayjs accepts both; this
 * spells out what actually reaches the helper rather than inheriting the lie.
 */
interface RevocationFields {
  revokedAt?: Date | string;
  revokedReason?: string;
}

/**
 * Whether a key has been revoked. `disabled` is the only state any revoke path
 * writes - revokeUserApiKey, the bulk deactivation and the cc-bridge device
 * revoke all stamp revokedAt with it - so it reads as "revoked" everywhere, and
 * it is the only state the delete route accepts.
 *
 * Compared against `ApiKeyStatus` rather than the bare string because the server
 * owns the value - `userApiKeyService/revoke.ts` writes the enum - and a literal
 * copied onto the client is the one spelling that could silently diverge.
 */
export function isRevoked(key: Pick<IUserApiKey, 'status'>): boolean {
  return key.status === ApiKeyStatus.DISABLED;
}

/**
 * Tooltip text for a revoked key's audit trail, shared by the admin embed-key
 * table and the personal API-key table so both read the same.
 *
 * Returns null when there is nothing truthful to show: keys disabled before
 * revocation metadata existed carry no timestamp, and `updatedAt` is not a
 * substitute (any write to the document bumps it).
 *
 * `revokedBy` is deliberately not rendered - it is a raw user id, and it is not
 * necessarily the minter (an org admin can revoke a key billed to an org they
 * administer). Surfacing it would need a username lookup this helper does not do.
 */
export function revocationTooltip(key: RevocationFields): string | null {
  if (!key.revokedAt) return null;

  const at = dayjs(key.revokedAt);
  const when = `Revoked ${at.fromNow()} (${at.format('MMM D, YYYY h:mm A')})`;

  return key.revokedReason ? `${when} - ${key.revokedReason}` : when;
}
