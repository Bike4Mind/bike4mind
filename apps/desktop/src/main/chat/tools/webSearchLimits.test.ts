import { describe, expect, it, vi } from 'vitest';
import {
  STOPPED_WHILE_QUEUED,
  WEB_SEARCH_CACHE_ENTRIES,
  WEB_SEARCH_CACHE_TTL_MS,
  WEB_SEARCH_MAX_CONCURRENT,
  WEB_SEARCH_TURN_BUDGET,
  WebSearchLimiter,
  webSearchCacheKey,
  type WebSearchRequest,
} from './webSearchLimits';

function deferred() {
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function request(key: string, overrides: Partial<WebSearchRequest> = {}): WebSearchRequest {
  return {
    key,
    signal: new AbortController().signal,
    send: vi.fn(async () => `results for ${key}`),
    cacheable: () => true,
    ...overrides,
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('webSearchCacheKey', () => {
  it('ignores case and spacing but not the result count', () => {
    expect(webSearchCacheKey('  Vitest   WATCH ', 3)).toBe(webSearchCacheKey('vitest watch', 3));
    expect(webSearchCacheKey('vitest', 3)).not.toBe(webSearchCacheKey('vitest', 5));
    expect(webSearchCacheKey('vitest', undefined)).not.toBe(webSearchCacheKey('vitest', 3));
  });
});

describe('WebSearchLimiter budget', () => {
  it('sends the first searches of a turn and refuses the rest without sending them', async () => {
    const turn = new WebSearchLimiter().turn('s1');
    for (let i = 0; i < WEB_SEARCH_TURN_BUDGET; i++) {
      await expect(turn.search(request(`q${i}`))).resolves.toMatchObject({ kind: 'searched' });
    }
    const over = request('one more');
    await expect(turn.search(over)).resolves.toEqual({ kind: 'exhausted' });
    expect(over.send).not.toHaveBeenCalled();
  });

  it('gives each turn its own budget', async () => {
    const limiter = new WebSearchLimiter();
    const first = limiter.turn('s1');
    for (let i = 0; i < WEB_SEARCH_TURN_BUDGET; i++) await first.search(request(`q${i}`));
    await expect(limiter.turn('s1').search(request('next turn'))).resolves.toMatchObject({ kind: 'searched' });
  });

  it('spends no budget on a reused result', async () => {
    const turn = new WebSearchLimiter().turn('s1');
    await turn.search(request('same'));
    for (let i = 0; i < 10; i++) await expect(turn.search(request('same'))).resolves.toMatchObject({ kind: 'reused' });
    for (let i = 1; i < WEB_SEARCH_TURN_BUDGET; i++) {
      await expect(turn.search(request(`q${i}`))).resolves.toMatchObject({ kind: 'searched' });
    }
  });

  it('counts a failed search against the budget', async () => {
    const turn = new WebSearchLimiter().turn('s1');
    const failing = () => request('bad', { send: async () => Promise.reject(new Error('fetch failed')) });
    for (let i = 0; i < WEB_SEARCH_TURN_BUDGET; i++) await expect(turn.search(failing())).rejects.toThrow();
    await expect(turn.search(request('fine'))).resolves.toEqual({ kind: 'exhausted' });
  });
});

describe('WebSearchLimiter concurrency', () => {
  it(`keeps ${WEB_SEARCH_MAX_CONCURRENT} in flight and starts the rest in order`, async () => {
    const turn = new WebSearchLimiter().turn('s1');
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const queued = vi.fn();
    const runs = gates.map((gate, i) =>
      turn.search(
        request(`q${i}`, {
          send: () => {
            started.push(i);
            return gate.promise;
          },
          onQueued: queued,
        })
      )
    );
    await flush();
    expect(started).toEqual([0, 1]);
    expect(queued).toHaveBeenCalledTimes(2);

    gates[1].resolve('one');
    await flush();
    expect(started).toEqual([0, 1, 2]);
    gates[0].resolve('zero');
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2].resolve('two');
    gates[3].resolve('three');
    await expect(Promise.all(runs)).resolves.toHaveLength(4);
  });

  it('frees the slot of a search that failed', async () => {
    const turn = new WebSearchLimiter().turn('s1');
    const gates = [deferred(), deferred()];
    const runs = gates.map((gate, i) => turn.search(request(`q${i}`, { send: () => gate.promise })));
    const waiting = request('third');
    const third = turn.search(waiting);
    await flush();
    expect(waiting.send).not.toHaveBeenCalled();
    gates[0].reject(new Error('boom'));
    await expect(runs[0]).rejects.toThrow('boom');
    await expect(third).resolves.toMatchObject({ kind: 'searched' });
    gates[1].resolve('ok');
    await runs[1];
  });

  it('drops a queued search when the turn stops, without sending it or holding a slot', async () => {
    const limiter = new WebSearchLimiter();
    const turn = limiter.turn('s1');
    const gates = [deferred(), deferred()];
    const runs = gates.map((gate, i) => turn.search(request(`q${i}`, { send: () => gate.promise })));
    const controller = new AbortController();
    const waiting = request('queued', { signal: controller.signal });
    const queued = turn.search(waiting);
    await flush();

    controller.abort();
    await expect(queued).rejects.toThrow(STOPPED_WHILE_QUEUED);
    expect(waiting.send).not.toHaveBeenCalled();

    gates[0].resolve('a');
    gates[1].resolve('b');
    await Promise.all(runs);
    const after = request('after');
    await expect(limiter.turn('s1').search(after)).resolves.toMatchObject({ kind: 'searched' });
  });

  it('refuses at once when the turn has already stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const stopped = request('q', { signal: controller.signal });
    await expect(new WebSearchLimiter().turn('s1').search(stopped)).rejects.toThrow(STOPPED_WHILE_QUEUED);
    expect(stopped.send).not.toHaveBeenCalled();
  });

  it('does not share slots between conversations', async () => {
    const limiter = new WebSearchLimiter();
    const hold = deferred();
    const busy = limiter.turn('s1');
    const runs = [
      busy.search(request('a', { send: () => hold.promise })),
      busy.search(request('b', { send: () => hold.promise })),
    ];
    await expect(limiter.turn('s2').search(request('c'))).resolves.toMatchObject({ kind: 'searched' });
    hold.resolve('done');
    await Promise.all(runs);
  });
});

describe('WebSearchLimiter cache', () => {
  it('reuses an identical search in the same conversation, and only there', async () => {
    const limiter = new WebSearchLimiter();
    await limiter.turn('s1').search(request('q'));
    const again = request('q');
    await expect(limiter.turn('s1').search(again)).resolves.toEqual({ kind: 'reused', text: 'results for q' });
    expect(again.send).not.toHaveBeenCalled();
    const elsewhere = request('q');
    await expect(limiter.turn('s2').search(elsewhere)).resolves.toMatchObject({ kind: 'searched' });
    expect(elsewhere.send).toHaveBeenCalled();
  });

  it('shares one request between identical searches made at once', async () => {
    const turn = new WebSearchLimiter().turn('s1');
    const gate = deferred();
    const first = request('q', { send: vi.fn(() => gate.promise) });
    const second = request('q');
    const runs = [turn.search(first), turn.search(second)];
    gate.resolve('shared');
    await expect(Promise.all(runs)).resolves.toEqual([
      { kind: 'searched', text: 'shared' },
      { kind: 'reused', text: 'shared' },
    ]);
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).not.toHaveBeenCalled();
  });

  it('searches again once the entry has expired', async () => {
    let now = 1_000_000;
    const limiter = new WebSearchLimiter(() => now);
    await limiter.turn('s1').search(request('q'));
    now += WEB_SEARCH_CACHE_TTL_MS - 1;
    await expect(limiter.turn('s1').search(request('q'))).resolves.toMatchObject({ kind: 'reused' });
    now += 1;
    await expect(limiter.turn('s1').search(request('q'))).resolves.toMatchObject({ kind: 'searched' });
  });

  it('evicts the least recently used entry past the cap', async () => {
    const limiter = new WebSearchLimiter();
    for (let i = 0; i < WEB_SEARCH_CACHE_ENTRIES; i++) await limiter.turn('s1').search(request(`q${i}`));
    await limiter.turn('s1').search(request('q0'));
    await limiter.turn('s1').search(request('newest'));

    await expect(limiter.turn('s1').search(request('q0'))).resolves.toMatchObject({ kind: 'reused' });
    await expect(limiter.turn('s1').search(request('q1'))).resolves.toMatchObject({ kind: 'searched' });
  });

  it('never keeps a failure, nor an answer the caller marks uncacheable', async () => {
    const limiter = new WebSearchLimiter();
    await expect(
      limiter.turn('s1').search(request('q', { send: async () => Promise.reject(new Error('fetch failed')) }))
    ).rejects.toThrow('fetch failed');
    await expect(limiter.turn('s1').search(request('q'))).resolves.toMatchObject({ kind: 'searched' });

    await limiter.turn('s1').search(request('nc', { cacheable: () => false }));
    await expect(limiter.turn('s1').search(request('nc'))).resolves.toMatchObject({ kind: 'searched' });
  });

  it('drops a conversation on forget, and sweeps idle ones whose entries expired', async () => {
    let now = 1_000_000;
    const limiter = new WebSearchLimiter(() => now);
    await limiter.turn('s1').search(request('q'));
    limiter.forget('s1');
    await expect(limiter.turn('s1').search(request('q'))).resolves.toMatchObject({ kind: 'searched' });

    for (let i = 0; i < 200; i++) await limiter.turn(`old${i}`).search(request('q'));
    expect(limiter.size).toBe(201);
    now += WEB_SEARCH_CACHE_TTL_MS;
    await limiter.turn('fresh').search(request('q'));
    expect(limiter.size).toBe(1);
  });
});
