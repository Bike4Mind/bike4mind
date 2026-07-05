import { createHmac } from 'crypto';
import type { AnonymousSessionId } from '../schemas/contextTelemetry';

/**
 * Anonymous Session ID Generator
 *
 * Creates privacy-preserving session identifiers using HMAC-SHA256.
 * The hash cannot be reversed to identify users.
 *
 * Hash format: HMAC-SHA256(key=dailySalt, data=userId|orgId|YYYY-MM-DD)
 *
 * Privacy guarantees:
 * - HMAC-SHA256 is cryptographically secure (not reversible)
 * - Daily salt rotation prevents long-term tracking
 * - Salt is used as HMAC key (not concatenated into plaintext)
 * - No lookup table maintained
 * - Different hash each day for same user
 */

/**
 * Generates a date key in YYYY-MM-DD format
 */
export function getDateKey(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

/**
 * Generates an anonymous session ID hash
 *
 * @param userId - The user's ID
 * @param orgId - The organization's ID
 * @param dailySalt - The daily rotation salt (from Secrets Manager)
 * @param date - Optional date for the hash (defaults to today)
 * @returns AnonymousSessionId with hash and dateKey
 */
export function generateAnonymousSessionId(
  userId: string,
  orgId: string,
  dailySalt: string,
  date: Date = new Date()
): AnonymousSessionId {
  const dateKey = getDateKey(date);

  // Create deterministic input string (salt is used as HMAC key, not in plaintext)
  const input = `${userId}|${orgId}|${dateKey}`;

  // Generate HMAC-SHA256 with salt as key (cryptographically stronger than plain hash)
  const hash = createHmac('sha256', dailySalt).update(input).digest('hex');

  return {
    hash,
    dateKey,
  };
}

/**
 * Regenerates hashes for deletion lookup
 *
 * When a user requests deletion, we need to find their telemetry records.
 * Since we rotate salts daily, we need to check multiple days.
 *
 * @param userId - The user's ID
 * @param orgId - The organization's ID
 * @param salts - Array of { salt, dateKey } for recent days (up to 7 days)
 * @returns Array of hashes that could match the user's telemetry
 */
export function regenerateHashesForDeletion(
  userId: string,
  orgId: string,
  salts: Array<{ salt: string; dateKey: string }>
): string[] {
  return salts.map(({ salt, dateKey }) => {
    const input = `${userId}|${orgId}|${dateKey}`;
    // Use HMAC-SHA256 with salt as key (matches generateAnonymousSessionId)
    return createHmac('sha256', salt).update(input).digest('hex');
  });
}

/**
 * Validates an anonymous session ID structure
 */
export function isValidAnonymousSessionId(sessionId: unknown): sessionId is AnonymousSessionId {
  if (!sessionId || typeof sessionId !== 'object') {
    return false;
  }

  const obj = sessionId as Record<string, unknown>;

  // Check hash is a valid SHA256 hex string (64 characters)
  if (typeof obj.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(obj.hash)) {
    return false;
  }

  // Check dateKey is a valid YYYY-MM-DD format
  if (typeof obj.dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.dateKey)) {
    return false;
  }

  return true;
}
