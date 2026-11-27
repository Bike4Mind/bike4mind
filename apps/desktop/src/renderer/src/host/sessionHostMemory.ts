import { LOCAL_HOST_ID } from '@shared/hostBridge';

/**
 * The remote host of each recently opened remote session, so a session remembered across a
 * restart (the last session, each place's last session) is asked of its own host even when it
 * sits past that host's first page. A session not in here is local, where every session lived
 * before remote hosts. Kept in localStorage like sessionListCache; a storage failure just means
 * nothing is remembered.
 */
export type SessionHostMemory = {
  /** Remembered remote sessions and their hosts, most recent last. */
  read(): ReadonlyMap<string, string>;
  /** Remembers where a session that was just opened lives; a local one is forgotten. */
  remember(sessionId: string, hostId: string): void;
  forgetHost(hostId: string): void;
};

const STORAGE_KEY = 'b4m.sessionHosts.v1';

/** Enough for every place's last session with room to spare; the oldest drop off first. */
export const SESSION_HOST_MEMORY_LIMIT = 20;

export function createSessionHostMemory(
  storage: () => Pick<Storage, 'getItem' | 'setItem'>,
  limit: number = SESSION_HOST_MEMORY_LIMIT
): SessionHostMemory {
  const read = (): Map<string, string> => {
    try {
      const raw = storage().getItem(STORAGE_KEY);
      if (!raw) return new Map();
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Map();
      const pairs = parsed.filter(
        (entry: unknown): entry is [string, string] =>
          Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string'
      );
      return new Map(pairs);
    } catch (error) {
      console.warn('Could not read the remembered session hosts', error);
      return new Map();
    }
  };
  const write = (hosts: Map<string, string>) => {
    try {
      storage().setItem(STORAGE_KEY, JSON.stringify([...hosts].slice(-limit)));
    } catch (error) {
      console.warn('Could not remember the session hosts', error);
    }
  };
  return {
    read,
    remember(sessionId, hostId) {
      const hosts = read();
      if (hostId === LOCAL_HOST_ID) {
        if (hosts.delete(sessionId)) write(hosts);
        return;
      }
      if ([...hosts.keys()].at(-1) === sessionId && hosts.get(sessionId) === hostId) return;
      hosts.delete(sessionId);
      write(hosts.set(sessionId, hostId));
    },
    forgetHost(hostId) {
      const hosts = read();
      const kept = new Map([...hosts].filter(([, owner]) => owner !== hostId));
      if (kept.size !== hosts.size) write(kept);
    },
  };
}

export const sessionHostMemory: SessionHostMemory = createSessionHostMemory(() => window.localStorage);
