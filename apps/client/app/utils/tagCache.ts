import { ISessionDocument } from '@bike4mind/common';

interface TagCacheEntry {
  sessionId: string;
  tagName: string;
  strength: number;
  lastUpdated: string | Date;
}

interface TagGroupCache {
  version: number;
  userId: string;
  timestamp: number;
  sessionCount: number;
  tagGroups: Map<string, string[]>; // tagName -> sessionIds
  sessionTags: Map<string, TagCacheEntry>; // sessionId -> highest tag
}

const CACHE_VERSION = 1;
const CACHE_KEY_PREFIX = 'tag_cache_';
const CACHE_EXPIRY_MS = 1000 * 60 * 60 * 24; // 24 hours

class TagCacheManager {
  private dbName = 'NotebookTagCache';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;

  async initialize(): Promise<void> {
    if (!('indexedDB' in window)) {
      console.warn('IndexedDB not supported, falling back to localStorage');
      return;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = event => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains('tagGroups')) {
          const store = db.createObjectStore('tagGroups', { keyPath: 'userId' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Per-session store, enables incremental updates.
        if (!db.objectStoreNames.contains('sessionTags')) {
          const store = db.createObjectStore('sessionTags', { keyPath: 'sessionId' });
          store.createIndex('userId', 'userId', { unique: false });
          store.createIndex('tagName', 'tagName', { unique: false });
        }
      };
    });
  }

  async getCachedTagGroups(userId: string): Promise<TagGroupCache | null> {
    if (this.db) {
      try {
        return await this.getFromIndexedDB(userId);
      } catch (error) {
        console.warn('IndexedDB read failed, falling back to localStorage', error);
      }
    }

    return this.getFromLocalStorage(userId);
  }

  async saveTagGroups(userId: string, sessions: ISessionDocument[], tagGroups: Map<string, string[]>): Promise<void> {
    const cache: TagGroupCache = {
      version: CACHE_VERSION,
      userId,
      timestamp: Date.now(),
      sessionCount: sessions.length,
      tagGroups,
      sessionTags: new Map(),
    };

    // Build session -> tag mapping for incremental updates
    sessions.forEach(session => {
      const validTags = session.tags?.filter(tag => tag.name !== '<favorite>') || [];
      if (validTags.length > 0) {
        const highestTag = validTags.reduce((prev, current) => (prev.strength > current.strength ? prev : current));
        cache.sessionTags.set(session.id, {
          sessionId: session.id,
          tagName: highestTag.name,
          strength: highestTag.strength,
          lastUpdated: session.lastUpdated,
        });
      }
    });

    if (this.db) {
      try {
        await this.saveToIndexedDB(cache);
      } catch (error) {
        console.warn('IndexedDB save failed, falling back to localStorage', error);
        this.saveToLocalStorage(cache);
      }
    } else {
      this.saveToLocalStorage(cache);
    }
  }

  isCacheValid(cache: TagGroupCache, currentSessionCount: number): boolean {
    if (cache.version !== CACHE_VERSION) return false;

    if (Date.now() - cache.timestamp > CACHE_EXPIRY_MS) return false;

    // A large session-count delta implies the data changed underneath us.
    if (Math.abs(cache.sessionCount - currentSessionCount) > 5) return false;

    return true;
  }

  async updateSessionTags(userId: string, sessionId: string, session: ISessionDocument): Promise<void> {
    const cache = await this.getCachedTagGroups(userId);
    if (!cache) return;

    const oldTag = cache.sessionTags.get(sessionId);

    const validTags = session.tags?.filter(tag => tag.name !== '<favorite>') || [];
    const newTag =
      validTags.length > 0
        ? validTags.reduce((prev, current) => (prev.strength > current.strength ? prev : current))
        : null;

    if (oldTag && cache.tagGroups.has(oldTag.tagName)) {
      const group = cache.tagGroups.get(oldTag.tagName)!;
      const index = group.indexOf(sessionId);
      if (index > -1) group.splice(index, 1);
      if (group.length === 0) cache.tagGroups.delete(oldTag.tagName);
    }

    if (newTag) {
      if (!cache.tagGroups.has(newTag.name)) {
        cache.tagGroups.set(newTag.name, []);
      }
      cache.tagGroups.get(newTag.name)!.push(sessionId);

      cache.sessionTags.set(sessionId, {
        sessionId,
        tagName: newTag.name,
        strength: newTag.strength,
        lastUpdated: session.lastUpdated,
      });
    } else {
      cache.sessionTags.delete(sessionId);
    }

    cache.timestamp = Date.now();
    await this.saveTagGroups(userId, [], cache.tagGroups);
  }

  async clearCache(userId: string): Promise<void> {
    if (this.db) {
      try {
        const transaction = this.db.transaction(['tagGroups', 'sessionTags'], 'readwrite');
        await transaction.objectStore('tagGroups').delete(userId);
        const sessionStore = transaction.objectStore('sessionTags');
        const index = sessionStore.index('userId');
        const request = index.openCursor(IDBKeyRange.only(userId));
        request.onsuccess = event => {
          const cursor = (event.target as IDBRequest).result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
      } catch (error) {
        console.warn('Failed to clear IndexedDB cache', error);
      }
    }

    localStorage.removeItem(`${CACHE_KEY_PREFIX}${userId}`);
  }

  // Used on logout when userId is unavailable.
  async clearAllCaches(): Promise<void> {
    if (this.db) {
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = this.db!.transaction(['tagGroups', 'sessionTags'], 'readwrite');
          transaction.objectStore('tagGroups').clear();
          transaction.objectStore('sessionTags').clear();
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      } catch (error) {
        console.warn('Failed to clear all tag caches', error);
      }
    }

    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_KEY_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
  }

  private async getFromIndexedDB(userId: string): Promise<TagGroupCache | null> {
    if (!this.db) return null;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['tagGroups'], 'readonly');
      const request = transaction.objectStore('tagGroups').get(userId);

      request.onsuccess = () => {
        const data = request.result;
        if (data) {
          // Convert stored data back to Maps
          data.tagGroups = new Map(Object.entries(data.tagGroups));
          data.sessionTags = new Map(Object.entries(data.sessionTags));
        }
        resolve(data || null);
      };

      request.onerror = () => reject(request.error);
    });
  }

  private async saveToIndexedDB(cache: TagGroupCache): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['tagGroups'], 'readwrite');

      // Convert Maps to objects for storage
      const dataToStore = {
        ...cache,
        tagGroups: Object.fromEntries(cache.tagGroups),
        sessionTags: Object.fromEntries(cache.sessionTags),
      };

      const request = transaction.objectStore('tagGroups').put(dataToStore);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private getFromLocalStorage(userId: string): TagGroupCache | null {
    try {
      const stored = localStorage.getItem(`${CACHE_KEY_PREFIX}${userId}`);
      if (!stored) return null;

      const parsed = JSON.parse(stored);

      // Convert stored arrays back to Maps
      parsed.tagGroups = new Map(parsed.tagGroups);
      parsed.sessionTags = new Map(parsed.sessionTags);

      return parsed;
    } catch (error) {
      console.warn('Failed to parse localStorage cache', error);
      return null;
    }
  }

  private saveToLocalStorage(cache: TagGroupCache): void {
    try {
      if (this.isLocalStorageFull()) {
        this.clearOldLocalStorageCaches();
      }

      const dataToStore = {
        ...cache,
        tagGroups: Array.from(cache.tagGroups.entries()),
        sessionTags: Array.from(cache.sessionTags.entries()),
      };

      localStorage.setItem(`${CACHE_KEY_PREFIX}${cache.userId}`, JSON.stringify(dataToStore));
    } catch (error) {
      console.warn('Failed to save to localStorage', error);
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        this.clearOldLocalStorageCaches();
        try {
          const dataToStore = {
            ...cache,
            tagGroups: Array.from(cache.tagGroups.entries()),
            sessionTags: Array.from(cache.sessionTags.entries()),
          };
          localStorage.setItem(`${CACHE_KEY_PREFIX}${cache.userId}`, JSON.stringify(dataToStore));
        } catch {
          console.error('Cannot save to localStorage even after cleanup');
        }
      }
    }
  }

  private isLocalStorageFull(): boolean {
    try {
      const testKey = '__localStorage_test__';
      localStorage.setItem(testKey, 'test');
      localStorage.removeItem(testKey);
      return false;
    } catch {
      return true;
    }
  }

  private clearOldLocalStorageCaches(): void {
    const keysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_KEY_PREFIX)) {
        try {
          const data = JSON.parse(localStorage.getItem(key) || '{}');
          // Remove caches older than 24 hours
          if (Date.now() - data.timestamp > CACHE_EXPIRY_MS) {
            keysToRemove.push(key);
          }
        } catch {
          // Remove invalid caches
          keysToRemove.push(key!);
        }
      }
    }

    keysToRemove.forEach(key => localStorage.removeItem(key));
  }
}

export const tagCacheManager = new TagCacheManager();

// Initialize on first import
if (typeof window !== 'undefined') {
  tagCacheManager.initialize().catch(console.error);
}
