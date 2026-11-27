import { createHmac } from 'node:crypto';
import { Config } from '../utils/config';
import { pseudonymizeUserId } from '../analytics/pseudonymize';

// Pure variants take the key explicitly (testable); the unsuffixed ones derive it from JWT_SECRET.
// Rotating JWT_SECRET changes the key, so existing ErasureRecords stop matching. Every record stores
// erasureKeyId(), which is how the re-erasure script detects that instead of skipping them silently.

export const deriveErasureKey = (secret: string): Buffer =>
  createHmac('sha256', secret).update('erasure-record/v1').digest();

// Lower-cased: ObjectId hex is case-insensitive (an admin route may pass upper case), so the record and
// the script must hash one canonical form.
export const erasureIdHashWith = (key: Buffer, userId: string): string =>
  createHmac('sha256', key).update(`user:${userId.toLowerCase()}`).digest('hex');

export const erasureKeyIdWith = (key: Buffer): string =>
  createHmac('sha256', key).update('key-id').digest('hex').slice(0, 16);

// Config is built eagerly at import (utils/config); only the key derivation is deferred and memoized.
let cachedKey: Buffer | undefined;
const erasureKey = () => (cachedKey ??= deriveErasureKey(Config.JWT_SECRET));

/** Keyed hash of a user id: recognises a restored row without the record holding the id. */
export const erasureIdHash = (userId: string): string => erasureIdHashWith(erasureKey(), userId);

/** Fingerprint of the current key, stored on each record. */
export const erasureKeyId = (): string => erasureKeyIdWith(erasureKey());

/** The analytics pseudonym, only when a real salt is configured (unset or the placeholder gives null). */
export const erasurePseudonym = (userId: string): string | null => {
  const salt = Config.OVERWATCH_PSEUDONYM_SALT;
  return salt && salt !== 'not-configured' ? pseudonymizeUserId(userId) : null;
};
