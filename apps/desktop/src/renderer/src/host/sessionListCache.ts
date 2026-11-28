import type { ChatSessionSummary } from '@shared/chat';

/**
 * The last session list each remote host served, so a host that is offline (or not yet connected
 * after a restart) still shows its sessions, marked stale, rather than none. Only remote hosts are
 * cached: the local host is always there to ask. Kept in the renderer's localStorage, which
 * Electron persists across restarts; any storage failure just means no cache.
 */
export type SessionListCache = {
  read(hostId: string): ChatSessionSummary[];
  write(hostId: string, sessions: readonly ChatSessionSummary[]): void;
  forget(hostId: string): void;
};

const KEY_PREFIX = 'b4m.hostSessions.v1:';

/** The first page's worth, so the cache stays small however far the user scrolled. */
export const SESSION_LIST_CACHE_LIMIT = 100;

const isSummary = (value: unknown): value is ChatSessionSummary =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'string' &&
  'updatedAt' in value &&
  typeof value.updatedAt === 'string';

export function createSessionListCache(
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  limit: number = SESSION_LIST_CACHE_LIMIT
): SessionListCache {
  return {
    read(hostId) {
      try {
        const raw = storage().getItem(KEY_PREFIX + hostId);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isSummary) : [];
      } catch (error) {
        console.warn(`Could not read the cached sessions of host ${hostId}`, error);
        return [];
      }
    },
    write(hostId, sessions) {
      try {
        storage().setItem(KEY_PREFIX + hostId, JSON.stringify(sessions.slice(0, limit)));
      } catch (error) {
        console.warn(`Could not cache the sessions of host ${hostId}`, error);
      }
    },
    forget(hostId) {
      try {
        storage().removeItem(KEY_PREFIX + hostId);
      } catch (error) {
        console.warn(`Could not drop the cached sessions of host ${hostId}`, error);
      }
    },
  };
}

export const sessionListCache: SessionListCache = createSessionListCache(() => window.localStorage);
