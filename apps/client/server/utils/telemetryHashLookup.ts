import { regenerateHashesForDeletion } from '@bike4mind/common';
import { createHmac } from 'crypto';
import { User } from '@bike4mind/database';
import { Resource } from 'sst';

/** Number of days of telemetry to cover when regenerating hashes for DSAR/deletion */
const TELEMETRY_RETENTION_DAYS = 90;

/**
 * Derive daily HMAC salts for the telemetry retention window.
 * Shared by deletion, admin export, and user export endpoints.
 */
export function deriveTelemetrySalts(): { salt: string; dateKey: string }[] {
  const hmacSecret = Resource.SECRET_ENCRYPTION_KEY.value;
  const hasValidSecret = hmacSecret && hmacSecret !== 'not-configured';
  if (!hasValidSecret && process.env.NODE_ENV !== 'development') {
    console.warn(
      '[Telemetry] SECRET_ENCRYPTION_KEY not configured — using predictable fallback salt. Hashes are reversible.'
    );
  }
  return Array.from({ length: TELEMETRY_RETENTION_DAYS }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateKey = date.toISOString().split('T')[0];
    const salt = hasValidSecret
      ? createHmac('sha256', hmacSecret).update(dateKey).digest('hex')
      : `telemetry-salt-${dateKey}`; // Fallback for local dev only
    return { salt, dateKey };
  });
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
export async function regenerateUserTelemetryHashes(userId: string): Promise<string[]> {
  const salts = deriveTelemetrySalts();
  const orgId = await getUserOrgId(userId);
  return regenerateHashesForDeletion(userId, orgId, salts);
}
