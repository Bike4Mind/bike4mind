import { del } from 'idb-keyval';
import { dexie } from './dexie';
import { tagCacheManager } from './tagCache';
import { premiumLocalStorageKeyPrefixes } from '../premium-generated/premiumLocalStorageKeys.generated';

/**
 * User-specific localStorage keys that must be removed on identity change.
 * 'access-token-storage' is handled upstream by resetTokens() which persists nulled state.
 * 'user-context' is also nulled upstream by setCurrentUser(null), but we remove the key
 * entirely as defense-in-depth for paths where setCurrentUser isn't called (e.g. session expiry).
 */
const USER_SPECIFIC_LS_KEYS = ['layout-control', 'artifacts', 'artifact_versions', 'user-context'];

/**
 * Clears all client-side persistence layers (IndexedDB + localStorage).
 * Must be called on every identity-change path: logout, login-as-user,
 * return-to-admin, session expiry, and login page mount.
 *
 * Failures are swallowed - cache clearing must never block logout.
 */
export async function clearClientCaches(): Promise<void> {
  try {
    // Clear user-specific localStorage entries (Zustand stores + artifact cache)
    USER_SPECIFIC_LS_KEYS.forEach(key => localStorage.removeItem(key));
    removePremiumLocalStorageKeys();

    await Promise.all([
      // React Query IndexedDB persistence (idb-keyval)
      del('reactQuery'),
      // Dexie: atomically close connection + delete entire database.
      // Safer than table-by-table clearing which can partially fail or be
      // re-populated by in-flight WebSocket messages during the async gap.
      // Dexie auto-reopens with fresh schema on next table access after login.
      dexie.delete(),
      // NotebookTagCache (custom IndexedDB - clear all users since userId unavailable at logout)
      tagCacheManager.clearAllCaches(),
    ]);
  } catch (error) {
    console.warn('Failed to clear client caches:', error);
  }
}

/**
 * Removes every localStorage key a premium overlay has claimed via
 * `b4mContributions.localStorageKeyPrefixes` (see `PremiumLocalStorageKeyPrefixes`).
 *
 * Prefix matching rather than an allowlist because core cannot know the whole key:
 * an overlay's keys are typically user-scoped (`<prefix><userId>`), so the set is
 * open-ended and only the overlay can name its shape. This runs here, in core's
 * identity-change teardown, so it fires in EVERY tab that signs out - including one
 * that never loaded the overlay's routes and therefore never ran a line of its code.
 */
function removePremiumLocalStorageKeys(): void {
  if (premiumLocalStorageKeyPrefixes.length === 0) return;

  // Snapshot the keys first: Object.keys returns a plain array, whereas iterating
  // localStorage by index while removing entries re-indexes underneath and skips keys.
  Object.keys(localStorage)
    .filter(key => premiumLocalStorageKeyPrefixes.some(prefix => key.startsWith(prefix)))
    .forEach(key => localStorage.removeItem(key));
}
