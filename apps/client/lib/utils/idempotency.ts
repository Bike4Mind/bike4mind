import { v4 as uuidv4 } from 'uuid';
import { isQuotaExceededError, TTL } from '@client/app/utils/localStorageUtils';

// Key prefix for localStorage
const IDEMPOTENCY_STORAGE_PREFIX = 'idempotency:';

/**
 * Storage format for idempotency entries with timestamp for TTL
 */
interface IdempotencyEntry {
  key: string;
  createdAt: number;
}

/**
 * Generate a new idempotency key (UUID v4)
 * @returns A unique UUID v4 string
 */
export function generateIdempotencyKey(): string {
  return uuidv4();
}

/**
 * Store an idempotency key in localStorage with timestamp for TTL
 *
 * @param url The request URL to use as key
 * @param key The idempotency key to store
 */
export function storeIdempotencyKey(url: string, key: string): void {
  const entry: IdempotencyEntry = { key, createdAt: Date.now() };
  const storageKey = `${IDEMPOTENCY_STORAGE_PREFIX}${url}`;

  try {
    localStorage.setItem(storageKey, JSON.stringify(entry));
  } catch (error) {
    if (isQuotaExceededError(error)) {
      cleanupOldIdempotencyKeys();
      try {
        localStorage.setItem(storageKey, JSON.stringify(entry));
      } catch {
        console.warn('[Idempotency] Cannot store key even after cleanup');
      }
    }
  }
}

/**
 * Retrieve a previously stored idempotency key (handles both old and new formats)
 *
 * @param url The request URL to use as key
 * @returns The stored idempotency key, or null if none exists or expired
 */
export function getStoredIdempotencyKey(url: string): string | null {
  const storageKey = `${IDEMPOTENCY_STORAGE_PREFIX}${url}`;
  const stored = localStorage.getItem(storageKey);
  if (!stored) return null;

  try {
    const entry = JSON.parse(stored) as IdempotencyEntry;
    // Check if expired
    if (Date.now() - entry.createdAt > TTL.IDEMPOTENCY) {
      localStorage.removeItem(storageKey);
      return null;
    }
    return entry.key;
  } catch {
    // Legacy format (plain string) - return as-is but it will be cleaned up
    return stored;
  }
}

/**
 * Clear a stored idempotency key
 *
 * @param url The request URL to use as key
 */
export function clearIdempotencyKey(url: string): void {
  localStorage.removeItem(`${IDEMPOTENCY_STORAGE_PREFIX}${url}`);
}

/**
 * Get or generate an idempotency key for a request
 * If a key exists for the URL, it will be reused
 * Otherwise, a new key will be generated and stored
 *
 * @param url The request URL
 * @returns An idempotency key
 */
export function getOrCreateIdempotencyKey(url: string): string {
  const existingKey = getStoredIdempotencyKey(url);
  if (existingKey) {
    return existingKey;
  }

  const newKey = generateIdempotencyKey();
  storeIdempotencyKey(url, newKey);
  return newKey;
}

/**
 * Store an idempotency key with an additional UUID identifier
 *
 * @param url The request URL
 * @param uuid Additional UUID identifier
 * @param key The idempotency key to store
 */
export function storeIdempotencyKeyWithUUID(url: string, uuid: string, key: string): void {
  const entry: IdempotencyEntry = { key, createdAt: Date.now() };
  const storageKey = `${IDEMPOTENCY_STORAGE_PREFIX}${url}:${uuid}`;

  try {
    localStorage.setItem(storageKey, JSON.stringify(entry));
  } catch (error) {
    if (isQuotaExceededError(error)) {
      cleanupOldIdempotencyKeys();
      try {
        localStorage.setItem(storageKey, JSON.stringify(entry));
      } catch {
        console.warn('[Idempotency] Cannot store key even after cleanup');
      }
    }
  }
}

/**
 * Retrieve a previously stored idempotency key using URL and UUID
 *
 * @param url The request URL
 * @param uuid Additional UUID identifier
 * @returns The stored idempotency key, or null if none exists or expired
 */
export function getStoredIdempotencyKeyWithUUID(url: string, uuid: string): string | null {
  const storageKey = `${IDEMPOTENCY_STORAGE_PREFIX}${url}:${uuid}`;
  const stored = localStorage.getItem(storageKey);
  if (!stored) return null;

  try {
    const entry = JSON.parse(stored) as IdempotencyEntry;
    // Check if expired
    if (Date.now() - entry.createdAt > TTL.IDEMPOTENCY) {
      localStorage.removeItem(storageKey);
      return null;
    }
    return entry.key;
  } catch {
    // Legacy format (plain string) - return as-is but it will be cleaned up
    return stored;
  }
}

/**
 * Clear a stored idempotency key that uses URL and UUID
 *
 * @param url The request URL
 * @param uuid Additional UUID identifier
 */
export function clearIdempotencyKeyWithUUID(url: string, uuid: string): void {
  localStorage.removeItem(`${IDEMPOTENCY_STORAGE_PREFIX}${url}:${uuid}`);
}

/**
 * Get or generate an idempotency key using both URL and UUID
 * If a key exists for the URL+UUID combination, it will be reused
 * Otherwise, a new key will be generated and stored
 *
 * @param url The request URL
 * @param uuid Additional UUID identifier
 * @returns An idempotency key
 */
export function getOrCreateIdempotencyKeyWithUUID(url: string, uuid: string): string {
  const existingKey = getStoredIdempotencyKeyWithUUID(url, uuid);
  if (existingKey) {
    return existingKey;
  }

  const newKey = generateIdempotencyKey();
  storeIdempotencyKeyWithUUID(url, uuid, newKey);
  return newKey;
}

/**
 * Clean up expired idempotency keys from localStorage
 * Removes entries older than 1 hour (TTL.IDEMPOTENCY) and legacy format entries
 *
 * @returns Number of keys removed
 */
export function cleanupOldIdempotencyKeys(): number {
  if (typeof window === 'undefined') return 0;

  const keysToRemove: string[] = [];
  const now = Date.now();

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(IDEMPOTENCY_STORAGE_PREFIX)) {
      try {
        const stored = localStorage.getItem(key);
        if (stored) {
          const entry = JSON.parse(stored) as IdempotencyEntry;
          // Remove if expired or invalid format
          if (!entry.createdAt || now - entry.createdAt > TTL.IDEMPOTENCY) {
            keysToRemove.push(key);
          }
        }
      } catch {
        // Legacy format (plain string) or invalid JSON - remove it
        keysToRemove.push(key);
      }
    }
  }

  keysToRemove.forEach(key => localStorage.removeItem(key));

  if (keysToRemove.length > 0) {
    console.log(`[Idempotency] Cleaned up ${keysToRemove.length} expired keys`);
  }

  return keysToRemove.length;
}
