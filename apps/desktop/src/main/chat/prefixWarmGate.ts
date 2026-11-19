import { createHash } from 'node:crypto';
import type { CompletionMessage } from './completions';

/**
 * Holds a request back while another with the same cacheable prefix is still waiting for its first
 * token. Anthropic makes a cache entry readable only once the response that writes it has begun,
 * so sibling agents started together each paid to write the same prefix; held, the later ones read
 * the leader's entry instead. The wait is bounded by the leader's time to first token, which a
 * held request would otherwise spend on its own cold prefix.
 */
export class PrefixWarmGate {
  private readonly warming = new Map<string, Promise<void>>();

  constructor(private readonly maxWaitMs = 15_000) {}

  /**
   * Waits out a leader with the same key, if there is one; otherwise becomes the leader. Returns the
   * release to call once this request's first token arrives or it ends, whichever is first.
   */
  async enter(key: string, signal?: AbortSignal): Promise<() => void> {
    const leader = this.warming.get(key);
    if (leader) {
      await waitFor(leader, this.maxWaitMs, signal);
      return () => undefined;
    }
    let resolve!: () => void;
    const warmed = new Promise<void>(done => (resolve = done));
    this.warming.set(key, warmed);
    return () => {
      resolve();
      if (this.warming.get(key) === warmed) this.warming.delete(key);
    };
  }
}

/** The cached prefix a request writes: model, tools and the system prompt up to its per-session tail. */
export function prefixKey(model: string, tools: readonly unknown[], system: CompletionMessage | undefined): string {
  const content = typeof system?.content === 'string' ? system.content : '';
  const shared = system?.cacheSplitAt ? content.slice(0, system.cacheSplitAt) : content;
  return createHash('sha256')
    .update(model)
    .update('\0')
    .update(JSON.stringify(tools))
    .update('\0')
    .update(shared)
    .digest('hex');
}

function waitFor(leader: Promise<void>, maxWaitMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, maxWaitMs);
    signal?.addEventListener('abort', done, { once: true });
    void leader.then(done);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
