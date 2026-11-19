import { regenerateHashesForDeletion } from '@bike4mind/common';
import { createHmac } from 'crypto';
import { User, questRepository, organizationRepository } from '@bike4mind/database';
import { signingKey, verificationKeys } from '@bike4mind/server-utils/security/signingKeys';
import { normalizeTelemetryUserId } from './telemetryIdentity';

/** Number of days of telemetry to cover when regenerating hashes for DSAR/deletion */
const TELEMETRY_RETENTION_DAYS = 90;

/**
 * Derive daily HMAC salts for the telemetry retention window, one set per accepted signing key
 * so records written under a previous key are still found.
 * Shared by deletion, admin export, and user export endpoints.
 */
export function deriveTelemetrySalts(): { salt: string; dateKey: string }[] {
  const hmacSecrets = verificationKeys('telemetry-salt');
  // The writer salts with any value other than empty or 'not-configured', placeholders included.
  const writerKey = signingKey('telemetry-salt');
  if (writerKey && writerKey !== 'not-configured' && !hmacSecrets.includes(writerKey)) hmacSecrets.push(writerKey);
  if (hmacSecrets.length === 0 && process.env.NODE_ENV !== 'development') {
    console.warn(
      '[Telemetry] Neither HMAC_SIGNING_SECRET nor SECRET_ENCRYPTION_KEY is configured - using predictable fallback salt. Hashes are reversible.'
    );
  }
  // The rolling cutoff intersects this UTC date too, even before its time of day has elapsed.
  const referenceTime = new Date();
  return Array.from({ length: TELEMETRY_RETENTION_DAYS + 1 }, (_, daysAgo) => {
    const date = new Date(referenceTime.getTime());
    date.setUTCDate(referenceTime.getUTCDate() - daysAgo);
    const dateKey = date.toISOString().split('T')[0];
    const salts = hmacSecrets.length
      ? hmacSecrets.map(hmacSecret => createHmac('sha256', hmacSecret).update(dateKey).digest('hex'))
      : [`telemetry-salt-${dateKey}`]; // Fallback for local dev only
    return salts.map(salt => ({ salt, dateKey }));
  }).flat();
}

/**
 * Look up a user's organizationId and return it as a string.
 * Falls back to 'default' if the user has no organization.
 *
 * Note: current data model supports a single organizationId per user.
 * If multi-org is added, this must iterate over all historical orgIds.
 */
export async function getUserOrgId(userId: string): Promise<string> {
  const user = await User.findById(userId).select('organizationId').lean();
  return (
    (user as Record<string, unknown> & { organizationId?: { toString(): string } })?.organizationId?.toString() ??
    'default'
  );
}

/**
 * Regenerate all possible telemetry hashes for a user across the retention window.
 * Used for DSAR export (find records) and deletion (remove records).
 */
export async function regenerateUserTelemetryHashes(rawUserId: string): Promise<string[]> {
  const userId = normalizeTelemetryUserId(rawUserId);
  const salts = deriveTelemetrySalts();
  const [currentOrgId, membershipOrgIds, historicalOrgIds] = await Promise.all([
    getUserOrgId(userId),
    organizationRepository.findMembershipOrgIds(userId),
    questRepository.findOrganizationIdsForUser(userId),
  ]);
  const orgIds = new Set(['default', currentOrgId, ...membershipOrgIds, ...historicalOrgIds]);
  return [...orgIds].flatMap(orgId => regenerateHashesForDeletion(userId, orgId, salts));
}
