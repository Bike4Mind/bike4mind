import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { IUserApiKey } from '@bike4mind/common';

dayjs.extend(relativeTime);

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
export function revocationTooltip(key: Pick<IUserApiKey, 'revokedAt' | 'revokedReason'>): string | null {
  if (!key.revokedAt) return null;

  const at = dayjs(key.revokedAt);
  const when = `Revoked ${at.fromNow()} (${at.format('MMM D, YYYY h:mm A')})`;

  return key.revokedReason ? `${when} - ${key.revokedReason}` : when;
}
