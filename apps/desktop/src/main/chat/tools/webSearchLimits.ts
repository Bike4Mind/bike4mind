/**
 * Spending limits on web_search, which the server answers through a paid provider that stalls on
 * a share of fresh queries. Each search a turn sends is both a charge and one more chance to hold
 * the turn for the length of a stall, so a turn gets a budget, a conversation gets a small number
 * of searches in flight, and a repeated query is answered from what the last one returned.
 *
 * web_fetch is not limited here: it does not go through the search provider.
 */

/** web_search calls one user turn may send to the server, from the user's message to the reply's end. */
export const WEB_SEARCH_TURN_BUDGET = 5;
/** Searches one conversation may have in flight; the rest wait in the order they were made. */
export const WEB_SEARCH_MAX_CONCURRENT = 2;
export const WEB_SEARCH_CACHE_TTL_MS = 10 * 60_000;
/** Per conversation, least recently used dropped first. */
export const WEB_SEARCH_CACHE_ENTRIES = 50;
/** How often expired entries and idle conversations are swept, at most. */
const SWEEP_INTERVAL_MS = 60_000;

export const STOPPED_WHILE_QUEUED = 'Stopped: the turn was interrupted while the web search waited for a slot.';

export type WebSearchOutcome = { kind: 'searched' | 'reused'; text: string } | { kind: 'exhausted' };

export interface WebSearchRequest {
  /** The search as the cache tells two apart; see webSearchCacheKey. */
  key: string;
  signal: AbortSignal;
  send: () => Promise<string>;
  /** Whether an answer may be reused; a failure never is, since it throws. */
  cacheable: (text: string) => boolean;
  /** Called when this search has to wait for a slot; onStarted when a waiting one gets it. */
  onQueued?: () => void;
  onStarted?: () => void;
}

/** One user turn's view of its conversation's searches. Its budget dies with the turn. */
export interface WebSearchTurn {
  search(request: WebSearchRequest): Promise<WebSearchOutcome>;
}

interface Waiter {
  start: () => void;
  stop: () => void;
}

interface SessionSearches {
  active: number;
  waiting: Waiter[];
  /** Map order is recency: a hit is moved to the end, and eviction takes the first key. */
  cache: Map<string, { text: string; at: number }>;
  inflight: Map<string, Promise<string>>;
}

export function webSearchCacheKey(query: string, numResults: number | undefined): string {
  const normalized = query.trim().replace(/\s+/g, ' ').toLowerCase();
  return `${numResults ?? ''}\x00${normalized}`;
}

export class WebSearchLimiter {
  private readonly sessions = new Map<string, SessionSearches>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  turn(sessionId: string): WebSearchTurn {
    let used = 0;
    const claim = () => {
      if (used >= WEB_SEARCH_TURN_BUDGET) return false;
      used += 1;
      return true;
    };
    return { search: request => this.search(sessionId, request, claim) };
  }

  /** Drops a conversation's cache. A search still running finishes against the dropped state. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** For tests: how many conversations hold state. */
  get size(): number {
    return this.sessions.size;
  }

  private async search(sessionId: string, request: WebSearchRequest, claim: () => boolean): Promise<WebSearchOutcome> {
    this.sweep();
    const state = this.stateFor(sessionId);
    const hit = state.cache.get(request.key);
    if (hit && this.now() - hit.at < WEB_SEARCH_CACHE_TTL_MS) {
      state.cache.delete(request.key);
      state.cache.set(request.key, hit);
      return { kind: 'reused', text: hit.text };
    }
    if (hit) state.cache.delete(request.key);

    const pending = state.inflight.get(request.key);
    if (pending) return { kind: 'reused', text: await pending };

    if (!claim()) return { kind: 'exhausted' };

    const run = this.runInSlot(state, request);
    state.inflight.set(request.key, run);
    try {
      const text = await run;
      if (request.cacheable(text)) this.remember(state, request.key, text);
      return { kind: 'searched', text };
    } finally {
      state.inflight.delete(request.key);
    }
  }

  private async runInSlot(state: SessionSearches, request: WebSearchRequest): Promise<string> {
    await this.acquire(state, request);
    try {
      return await request.send();
    } finally {
      this.release(state);
    }
  }

  private acquire(state: SessionSearches, request: WebSearchRequest): Promise<void> {
    const { signal } = request;
    if (signal.aborted) return Promise.reject(new Error(STOPPED_WHILE_QUEUED));
    if (state.active < WEB_SEARCH_MAX_CONCURRENT) {
      state.active += 1;
      return Promise.resolve();
    }
    request.onQueued?.();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        start: () => {
          signal.removeEventListener('abort', onAbort);
          request.onStarted?.();
          resolve();
        },
        stop: () => reject(new Error(STOPPED_WHILE_QUEUED)),
      };
      const onAbort = () => {
        const index = state.waiting.indexOf(waiter);
        if (index !== -1) state.waiting.splice(index, 1);
        waiter.stop();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      state.waiting.push(waiter);
    });
  }

  private release(state: SessionSearches): void {
    const next = state.waiting.shift();
    // Handed over rather than freed and retaken, so a search that arrives now cannot jump the queue.
    if (next) next.start();
    else state.active -= 1;
  }

  private remember(state: SessionSearches, key: string, text: string): void {
    state.cache.delete(key);
    state.cache.set(key, { text, at: this.now() });
    while (state.cache.size > WEB_SEARCH_CACHE_ENTRIES) {
      const oldest = state.cache.keys().next().value;
      if (oldest === undefined) break;
      state.cache.delete(oldest);
    }
  }

  private stateFor(sessionId: string): SessionSearches {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { active: 0, waiting: [], cache: new Map(), inflight: new Map() };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * Bounds what conversations nobody deletes keep holding: expired entries go, and so does a
   * conversation left with no cache and nothing running. Throttled, so a busy app pays one pass
   * over its conversations a minute at most rather than one per search.
   */
  private sweep(): void {
    const now = this.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [sessionId, state] of this.sessions) {
      for (const [key, entry] of state.cache) {
        if (now - entry.at >= WEB_SEARCH_CACHE_TTL_MS) state.cache.delete(key);
      }
      if (state.cache.size === 0 && state.active === 0 && state.waiting.length === 0) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
