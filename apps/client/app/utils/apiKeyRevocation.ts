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
 * Tooltip text for a revoked key's audit trail, shared by the admin embed-key
 * table and the personal API-key table so both read the same.
 *
 * Returns null when there is nothing truthful to show: keys disabled before
 * revocation metadata existed carry no timestamp, and `updatedAt` is not a
 * substitute (any write to the document bumps it).
 *
 * `revokedBy` is deliberately not rendered - it is a raw user id that always
 * equals the key's minter while every revoke path is minter-scoped.
 */
export function revocationTooltip(key: RevocationFields): string | null {
  if (!key.revokedAt) return null;

  const at = dayjs(key.revokedAt);
  const when = `Revoked ${at.fromNow()} (${at.format('MMM D, YYYY h:mm A')})`;

  return key.revokedReason ? `${when} - ${key.revokedReason}` : when;
}
