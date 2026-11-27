import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../chat/SessionStore';
import { LocalUsageService, type LocalUsageServiceDeps } from './LocalUsageService';
import { isUsageWindow, UsageService } from './UsageService';
import { localUsageWindow, sessionUsageBuckets, serverLabel, type LocalUsageBucket } from './localUsage';
import { dailyBars, featureRows, hourlyBars, humanize, modelRows, sourceRows, sumBars } from './usageBuckets';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatMessage, ChatUsage } from '@shared/chat';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

describe('LocalUsageService', () => {
  const NOW = Date.parse('2026-11-02T15:20:00.000Z');

  function bucket(outputTokens: number): LocalUsageBucket {
    return {
      model: 'local:ollama:llama3.2',
      hour: Date.parse('2026-11-02T15:00:00.000Z'),
      replies: 1,
      outputTokens,
      contextTokens: 0,
      timedReplies: 0,
      evalTokens: 0,
      evalMs: 0,
      estimatedReplies: 0,
      estimatedEvalTokens: 0,
      estimatedEvalMs: 0,
      promptTokens: 0,
      promptMs: 0,
      loads: 0,
      loadMs: 0,
      draftTokens: 0,
      draftAccepted: 0,
    };
  }

  function service(overrides: Partial<LocalUsageServiceDeps> = {}) {
    let now = NOW;
    let scope: string | null = 'device-local';
    const buckets = vi.fn(async () => ({ scope: 'device' as const, buckets: [bucket(10)] }));
    const deps: LocalUsageServiceDeps = {
      logger: { warn: vi.fn() },
      scan: buckets,
      scopeKey: () => scope,
      serverNames: async () => new Map(),
      now: () => now,
      ...overrides,
    };
    return {
      service: new LocalUsageService(deps),
      buckets,
      advance: (ms: number) => (now += ms),
      setScope: (next: string | null) => (scope = next),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('LocalUsageService', () => {
    it('serves a repeat read from the cache, and reads again when forced or stale', async () => {
      const { service: usage, buckets, advance } = service();
      const first = await usage.usage('last-24-hours');
      expect(first).toMatchObject({ ok: true, usage: { totals: { outputTokens: 10 }, readAt: NOW } });

      await usage.usage('last-24-hours');
      expect(buckets).toHaveBeenCalledTimes(1);

      await usage.usage('last-24-hours', true);
      expect(buckets).toHaveBeenCalledTimes(2);

      advance(14_999);
      await usage.usage('last-24-hours');
      expect(buckets).toHaveBeenCalledTimes(2);

      advance(1);
      await usage.usage('last-24-hours');
      expect(buckets).toHaveBeenCalledTimes(3);
    });

    it('never serves one scope the answer cached for another', async () => {
      const { service: usage, buckets, setScope } = service();
      await usage.usage('last-24-hours');
      setScope('account-folder');
      await usage.usage('last-24-hours');
      expect(buckets).toHaveBeenCalledTimes(2);
    });

    it('shares one read between overlapping asks', async () => {
      const { service: usage, buckets } = service();
      await Promise.all([usage.usage('last-30-days'), usage.usage('last-30-days')]);
      expect(buckets).toHaveBeenCalledTimes(1);
    });

    it('computes each window from one cached scan, so flipping windows reads nothing again', async () => {
      const { service: usage, buckets } = service();
      const day = await usage.usage('last-24-hours');
      const month = await usage.usage('last-30-days');
      expect(buckets).toHaveBeenCalledTimes(1);
      expect(day).toMatchObject({ ok: true, usage: { window: 'last-24-hours', granularity: 'hour' } });
      expect(month).toMatchObject({ ok: true, usage: { window: 'last-30-days', granularity: 'day' } });
    });

    it('drops the scan of both windows on a forced read', async () => {
      let tokens = 10;
      const scan = vi.fn(async () => ({ scope: 'device' as const, buckets: [bucket(tokens)] }));
      const { service: usage } = service({ scan });
      await usage.usage('last-24-hours');
      await usage.usage('last-30-days');
      tokens = 25;
      await usage.usage('last-24-hours', true);
      expect(await usage.usage('last-30-days')).toMatchObject({ ok: true, usage: { totals: { outputTokens: 25 } } });
      expect(scan).toHaveBeenCalledTimes(2);
    });

    it('reads past a scan still in flight when forced, and keeps only the newer answer', async () => {
      const resolvers: ((value: Awaited<ReturnType<LocalUsageServiceDeps['scan']>>) => void)[] = [];
      const scan = vi.fn(() => new Promise<Awaited<ReturnType<LocalUsageServiceDeps['scan']>>>(r => resolvers.push(r)));
      const { service: usage } = service({ scan });
      const stale = usage.usage('last-24-hours');
      const fresh = usage.usage('last-24-hours', true);
      expect(scan).toHaveBeenCalledTimes(2);
      resolvers[1]({ scope: 'device', buckets: [bucket(30)] });
      await fresh;
      resolvers[0]({ scope: 'device', buckets: [bucket(1)] });
      await stale;
      expect(await usage.usage('last-24-hours')).toMatchObject({ ok: true, usage: { totals: { outputTokens: 30 } } });
      expect(scan).toHaveBeenCalledTimes(2);
    });

    it('refuses an unknown window, and keeps a failed read with its reason until a forced read retries', async () => {
      const failing = vi
        .fn()
        .mockRejectedValueOnce(new Error('EACCES: permission denied'))
        .mockResolvedValue({ scope: 'device', buckets: [bucket(1)] });
      const { service: usage } = service({ scan: failing });
      expect(await usage.usage('last-year' as never)).toEqual({ ok: false, error: 'Unknown usage window.' });
      expect(await usage.usage('last-24-hours')).toEqual({
        ok: false,
        error: 'Could not read local model usage: EACCES: permission denied',
      });
      expect(await usage.usage('last-30-days')).toMatchObject({ ok: false });
      expect(failing).toHaveBeenCalledTimes(1);
      expect(await usage.usage('last-24-hours', true)).toMatchObject({ ok: true });
    });

    it('also reports a scan that throws before returning a promise', async () => {
      const scan = vi.fn((): never => {
        throw new Error('bad store');
      });
      const { service: usage } = service({ scan });
      expect(await usage.usage('last-24-hours')).toEqual({
        ok: false,
        error: 'Could not read local model usage: bad store',
      });
    });

    it('leaves the colon off when a failure carries no reason', async () => {
      for (const message of ['', '  ']) {
        const { service: usage } = service({ scan: vi.fn().mockRejectedValue(new Error(message)) });
        expect(await usage.usage('last-24-hours')).toEqual({ ok: false, error: 'Could not read local model usage' });
      }
      const { service: reasoned } = service({ scan: vi.fn().mockRejectedValue(new Error(' disk full ')) });
      expect(await reasoned.usage('last-24-hours')).toEqual({
        ok: false,
        error: 'Could not read local model usage: disk full',
      });
    });

    it('asks the scan for a fresh read only when forced', async () => {
      const { service: usage, buckets } = service();
      await usage.usage('last-24-hours');
      await usage.usage('last-24-hours', true);
      expect(buckets.mock.calls).toEqual([[false], [true]]);
    });

    it('says which kind of scope the figures came from', async () => {
      const scan = vi.fn(async () => ({ scope: 'account' as const, buckets: [bucket(1)] }));
      const { service: usage } = service({ scan });
      expect(await usage.usage('last-24-hours')).toMatchObject({ ok: true, usage: { scope: 'account' } });
    });

    it('names servers by runtime id when the saved servers cannot be read', async () => {
      const scan = vi.fn(async () => ({
        scope: 'device' as const,
        buckets: [{ ...bucket(5), model: 'local:srv-box:qwen3' }],
      }));
      const { service: usage } = service({ scan, serverNames: () => Promise.reject(new Error('locked')) });
      expect(await usage.usage('last-24-hours')).toMatchObject({
        ok: true,
        usage: { byServer: [{ label: 'srv-box', outputTokens: 5 }] },
      });
    });

    it('computes from the session store without opening any connection', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const spies = [
        vi.spyOn(http, 'request'),
        vi.spyOn(http, 'get'),
        vi.spyOn(https, 'request'),
        vi.spyOn(https, 'get'),
        vi.spyOn(net, 'connect'),
        vi.spyOn(net, 'createConnection'),
      ];
      const root = await mkdtemp(join(tmpdir(), 'b4m-local-usage-service-'));
      await writeFile(
        join(root, 's1.json'),
        JSON.stringify({
          id: 's1',
          model: 'local:srv-box:qwen3',
          messages: [
            {
              id: 'r1',
              role: 'assistant',
              content: 'hi',
              createdAt: '2026-11-02T15:05:00.000Z',
              usage: { outputTokens: 12, rate: { evalTokens: 12, evalMs: 500 } },
            },
          ],
        }),
        'utf8'
      );
      const store = new SessionStore(root, 'hosted-model');
      const usage = new LocalUsageService({
        logger: { warn: vi.fn() },
        scan: () => store.localUsage(),
        scopeKey: () => null,
        serverNames: async () => new Map([['box', 'Studio box']]),
        now: () => NOW,
      });

      const result = await usage.usage('last-24-hours', true);
      expect(result).toMatchObject({
        ok: true,
        usage: { totals: { outputTokens: 12 }, byServer: [{ label: 'Studio box', outputTokens: 12 }] },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });

    it('imports nothing that can reach a server', async () => {
      const sources = await Promise.all(
        ['LocalUsageService.ts', 'localUsage.ts', '../chat/tokenRate.ts'].map(name =>
          readFile(join(__dirname, name), 'utf8')
        )
      );
      const local = new Set(['./localUsage', '../chat/tokenRate']);
      for (const source of sources) {
        const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
        expect(imports.every(path => path.startsWith('@shared/') || local.has(path))).toBe(true);
        expect(source).not.toMatch(/\bfetch\(|axios|client-auth|electron/);
      }
    });
  });
});

describe('UsageService', () => {
  const NOW = Date.parse('2026-10-07T12:00:00.000Z');

  const USAGE_BODY = {
    overTime: [{ day: '2026-10-07', creditsCharged: 50, requests: 5 }],
    byModel: [{ provider: 'anthropic', model: 'claude-opus-5', creditsCharged: 50, requests: 5 }],
    byFeature: [{ feature: 'chat', creditsCharged: 50, requests: 5 }],
    bySource: [{ source: 'desktop', creditsSpent: 50, requests: 5 }],
  };

  function service(get: ReturnType<typeof vi.fn>, options: { userId?: string | null; now?: () => number } = {}) {
    const { userId = 'user-1', now = () => NOW } = options;
    return new UsageService({
      logger: { warn: () => {} },
      getApiClient: () => (userId ? ({ get } as unknown as AuthenticatedApiClient) : null),
      getUserId: () => userId,
      now,
    });
  }

  function respond(url: string): unknown {
    return url.startsWith('/api/credits/transactions')
      ? [{ createdAt: '2026-10-07T11:30:00.000Z', credits: -12 }]
      : USAGE_BODY;
  }

  describe('UsageService', () => {
    it('asks only for the signed-in account, by id', async () => {
      const get = vi.fn(respond);
      await service(get).history('last-30-days');
      expect(get).toHaveBeenCalledWith('/api/usage?ownerType=User&ownerId=user-1&days=30');
    });

    it('buckets the short window by hour out of the ledger', async () => {
      const get = vi.fn(respond);
      const result = await service(get).history('last-24-hours');

      expect(get).toHaveBeenCalledWith('/api/credits/transactions?days=1&type=deducted');
      expect(result.ok && result.usage.granularity).toBe('hour');
      expect(result.ok && result.usage.bars).toHaveLength(24);
      expect(result.ok && result.usage.creditsSpent).toBe(12);
    });

    // The server's own rollup is the only thing that can answer a month; it is day-granular.
    it('uses the server rollup for the long window and does not read the ledger', async () => {
      const get = vi.fn(respond);
      const result = await service(get).history('last-30-days');

      expect(get).toHaveBeenCalledTimes(1);
      expect(result.ok && result.usage.granularity).toBe('day');
      expect(result.ok && result.usage.creditsSpent).toBe(50);
    });

    it('carries all three breakdown cuts, which is what answers where the credits went', async () => {
      const result = await service(vi.fn(respond)).history('last-30-days');
      expect(result.ok && result.usage.byModel[0].label).toBe('claude-opus-5');
      expect(result.ok && result.usage.byFeature[0].label).toBe('Chat');
      expect(result.ok && result.usage.bySource[0].label).toBe('Desktop');
    });

    // Zero spend is an answer, not a failure: the screen draws an empty window, not an error.
    it('reports an empty window as a successful read', async () => {
      const result = await service(vi.fn(() => ({}))).history('last-30-days');
      expect(result.ok).toBe(true);
      expect(result.ok && result.usage.creditsSpent).toBe(0);
      expect(result.ok && result.usage.bars.length).toBeGreaterThan(0);
    });

    it('does not reach the network at all when signed out', async () => {
      const get = vi.fn();
      const result = await service(get, { userId: null }).history('last-30-days');
      expect(result).toEqual({ ok: false, error: 'Sign in to see your usage.' });
      expect(get).not.toHaveBeenCalled();
    });

    it('reports a failed read as a failure rather than as a window that spent nothing', async () => {
      const get = vi.fn().mockRejectedValue(new Error('403'));
      const result = await service(get).history('last-30-days');
      expect(result.ok).toBe(false);
    });

    it('refuses a window it does not know instead of asking the server for undefined days', async () => {
      const get = vi.fn(respond);
      const result = await service(get).history('last-decade' as 'last-30-days');
      expect(result.ok).toBe(false);
      expect(get).not.toHaveBeenCalled();
    });

    it('serves a repeat ask from the cache, and goes back to the server when forced', async () => {
      const get = vi.fn(respond);
      const usage = service(get);

      await usage.history('last-30-days');
      await usage.history('last-30-days');
      expect(get).toHaveBeenCalledTimes(1);

      await usage.history('last-30-days', true);
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('caches each window separately, so switching tabs does not serve the other one', async () => {
      const get = vi.fn(respond);
      const usage = service(get);

      await usage.history('last-30-days');
      const short = await usage.history('last-24-hours');
      expect(short.ok && short.usage.window).toBe('last-24-hours');
    });

    it('lets the cache lapse', async () => {
      const get = vi.fn(respond);
      let clock = NOW;
      const usage = service(get, { now: () => clock });

      await usage.history('last-30-days');
      clock += 120_000;
      await usage.history('last-30-days');
      expect(get).toHaveBeenCalledTimes(2);
    });

    // A cached failure would leave the screen's own Try again doing nothing for a minute.
    it('never holds on to a failure', async () => {
      const get = vi.fn().mockRejectedValueOnce(new Error('503')).mockImplementation(respond);
      const usage = service(get);

      expect((await usage.history('last-30-days')).ok).toBe(false);
      expect((await usage.history('last-30-days')).ok).toBe(true);
    });

    it('treats a ledger that answered with the wrong shape as a failed read', async () => {
      const get = vi.fn((url: string) => (url.startsWith('/api/credits') ? { error: 'nope' } : USAGE_BODY));
      const result = await service(get).history('last-24-hours');
      expect(result.ok).toBe(false);
    });

    it('accepts only its own window names from the renderer', () => {
      expect(isUsageWindow('last-24-hours')).toBe(true);
      for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
        expect(isUsageWindow(name)).toBe(false);
    });
  });
});

describe('localUsage', () => {
  const NOW = Date.parse('2026-11-02T15:20:00.000Z');
  const OLLAMA = 'local:ollama:llama3.2';
  const SERVER = 'local:srv-box:qwen3';

  let next = 0;
  /** `model` null is a reply stored before replies were stamped. */
  function reply(at: string, usage: ChatUsage, model: string | null = OLLAMA): ChatMessage {
    return {
      id: `m${next++}`,
      role: 'assistant',
      content: 'x',
      createdAt: at,
      ...(model ? { model } : {}),
      usage,
    };
  }

  function buckets(messages: ChatMessage[], model = OLLAMA): LocalUsageBucket[] {
    return sessionUsageBuckets({ model, messages });
  }

  const NAMES = new Map([['box', 'Studio box']]);

  describe('sessionUsageBuckets', () => {
    it('counts assistant replies on local models by model and UTC hour, from message.usage only', () => {
      const result = buckets([
        { id: 'u', role: 'user', content: 'hi', createdAt: '2026-11-02T15:01:00.000Z' },
        {
          ...reply('2026-11-02T15:05:00.000Z', { inputTokens: 900, outputTokens: 40 }),
          rounds: [{ text: 'x', toolCallIds: [], usage: { outputTokens: 40 } }],
        },
        reply('2026-11-02T15:55:00.000Z', { inputTokens: 1000, outputTokens: 60 }),
        reply('2026-11-02T16:01:00.000Z', { outputTokens: 5 }),
      ]);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ model: OLLAMA, replies: 2, outputTokens: 100, contextTokens: 1900 });
      expect(result[0].hour).toBe(Date.parse('2026-11-02T15:00:00.000Z'));
      expect(result[1]).toMatchObject({ replies: 1, outputTokens: 5 });
    });

    it('pins existing behavior: a cold model load stays out of the generation and prompt times', () => {
      const result = buckets([
        reply('2026-11-02T15:05:00.000Z', {
          outputTokens: 40,
          rate: { evalTokens: 40, evalMs: 1250, promptTokens: 900, promptMs: 500, loadMs: 28_000 },
        }),
      ]);
      expect(result[0]).toMatchObject({
        evalTokens: 40,
        evalMs: 1250,
        promptTokens: 900,
        promptMs: 500,
        loadMs: 28_000,
      });
      const { totals, byModel } = localUsageWindow(result, 'last-24-hours', NOW, NAMES);
      expect(totals.evalTokens / (totals.evalMs / 1000)).toBe(32);
      expect(byModel[0]).toMatchObject({ evalTokens: 40, evalMs: 1250 });
    });

    it('prefers the reply model stamp over the session model', () => {
      const result = buckets(
        [
          reply('2026-11-02T15:05:00.000Z', { outputTokens: 1 }, SERVER),
          reply('2026-11-02T15:07:00.000Z', { outputTokens: 4 }, 'claude-sonnet-5'),
        ],
        OLLAMA
      );
      expect(result.map(bucket => [bucket.model, bucket.outputTokens])).toEqual([[SERVER, 1]]);
    });

    it('attributes an unstamped reply by its context snapshot, else by the session only when it has a rate', () => {
      const at = '2026-11-02T15:05:00.000Z';
      const snapshot = (model: string) => ({ model, inputTokens: 10, overhead: [] });
      const result = buckets(
        [
          { ...reply(at, { outputTokens: 1 }, null), contextSnapshot: snapshot(SERVER) },
          { ...reply(at, { outputTokens: 2 }, null), contextSnapshot: snapshot('claude-sonnet-5') },
          reply(at, { outputTokens: 4, rate: { evalTokens: 4, evalMs: 100 } }, null),
          reply(at, { outputTokens: 8 }, null),
          {
            ...reply(at, { outputTokens: 16, rate: { evalTokens: 16, evalMs: 100 } }, null),
            promptCache: { cachedAt: Date.parse(at), ttl: '5m', model: 'claude-sonnet-5' },
          },
        ],
        OLLAMA
      );
      expect(result.map(bucket => [bucket.model, bucket.outputTokens])).toEqual([
        [SERVER, 1],
        [OLLAMA, 4],
      ]);
    });

    describe('a reply continued on another model', () => {
      const at = '2026-11-02T15:05:00.000Z';
      const round = (model: string | undefined, usage?: ChatUsage) => ({
        text: 'x',
        toolCallIds: [],
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
      });
      const totals = (result: LocalUsageBucket[]) => ({
        outputTokens: result.reduce((sum, bucket) => sum + bucket.outputTokens, 0),
        contextTokens: result.reduce((sum, bucket) => sum + bucket.contextTokens, 0),
      });

      it('splits it by the model each round went to, counting each token once and the reply once', () => {
        const result = buckets([
          {
            ...reply(at, {
              inputTokens: 700,
              outputTokens: 70,
              rate: { evalTokens: 70, evalMs: 1400, loadMs: 300 },
            }),
            rounds: [
              round(OLLAMA, { inputTokens: 100, outputTokens: 10, rate: { evalTokens: 10, evalMs: 400, loadMs: 300 } }),
              round(OLLAMA, { inputTokens: 200, outputTokens: 20, rate: { evalTokens: 20, evalMs: 500 } }),
              round(SERVER, { inputTokens: 400, outputTokens: 40, rate: { evalTokens: 40, evalMs: 500 } }),
            ],
          },
        ]);
        expect(result.map(bucket => [bucket.model, bucket.replies, bucket.outputTokens, bucket.contextTokens])).toEqual(
          [
            [OLLAMA, 1, 30, 300],
            [SERVER, 0, 40, 400],
          ]
        );
        expect(totals(result)).toEqual({ outputTokens: 70, contextTokens: 700 });
        expect(result[0]).toMatchObject({ timedReplies: 1, evalTokens: 30, evalMs: 900, loads: 1, loadMs: 300 });
        expect(result[1]).toMatchObject({ timedReplies: 0, evalTokens: 40, evalMs: 500, loads: 0 });
      });

      it('counts a share untimed when its rounds carry no rate, even if the reply does', () => {
        const result = buckets([
          {
            ...reply(at, { outputTokens: 30, rate: { evalTokens: 30, evalMs: 600 } }),
            rounds: [round(OLLAMA, { outputTokens: 10 }), round(SERVER, { outputTokens: 20 })],
          },
        ]);
        expect(result.map(bucket => [bucket.model, bucket.timedReplies, bucket.evalTokens])).toEqual([
          [OLLAMA, 0, 0],
          [SERVER, 0, 0],
        ]);
      });

      it('adds a load time only on the model the reply started on, so the average is per reply', () => {
        const result = buckets([
          {
            ...reply(at, { outputTokens: 30, rate: { evalTokens: 30, evalMs: 600, loadMs: 800 } }),
            rounds: [
              round(OLLAMA, { outputTokens: 10, rate: { evalTokens: 10, evalMs: 200, loadMs: 300 } }),
              round(SERVER, { outputTokens: 20, rate: { evalTokens: 20, evalMs: 400, loadMs: 500 } }),
            ],
          },
        ]);
        expect(result.map(bucket => [bucket.model, bucket.loads, bucket.loadMs])).toEqual([
          [OLLAMA, 1, 300],
          [SERVER, 0, 0],
        ]);
        const { totals } = localUsageWindow(result, 'last-24-hours', NOW, NAMES);
        expect(totals.loadMs / totals.loads).toBe(300);
      });

      it('counts a reply that started hosted on no local model, and a reply that started local once', () => {
        const result = buckets([
          {
            ...reply(at, { inputTokens: 1100, outputTokens: 110 }, 'claude-sonnet-5'),
            rounds: [
              round('claude-sonnet-5', { inputTokens: 1000, outputTokens: 100 }),
              round(OLLAMA, { inputTokens: 100, outputTokens: 10 }),
            ],
          },
          reply(at, { outputTokens: 7 }, OLLAMA),
        ]);
        expect(result.map(bucket => [bucket.model, bucket.replies, bucket.outputTokens])).toEqual([[OLLAMA, 1, 17]]);
      });

      it('counts a reply that started local even when only its later rounds carry usage', () => {
        const result = buckets([
          {
            ...reply(at, { outputTokens: 40 }, OLLAMA),
            rounds: [round(OLLAMA), round(SERVER, { outputTokens: 40 })],
          },
        ]);
        expect(result.map(bucket => [bucket.model, bucket.replies, bucket.outputTokens])).toEqual([
          [SERVER, 0, 40],
          [OLLAMA, 1, 0],
        ]);
      });

      describe('as ChatService stores it', () => {
        const HOSTED = 'claude-sonnet-5';

        it('hosted to local, the local run aborted: only the local round counts', () => {
          const result = buckets([
            {
              ...reply(at, { inputTokens: 1050, outputTokens: 205 }, HOSTED),
              stopReason: 'aborted',
              rounds: [
                round(HOSTED, { inputTokens: 1000, outputTokens: 200 }),
                round(OLLAMA, { inputTokens: 50, outputTokens: 5 }),
              ],
            },
          ]);
          expect(
            result.map(bucket => [bucket.model, bucket.replies, bucket.outputTokens, bucket.contextTokens])
          ).toEqual([[OLLAMA, 0, 5, 50]]);
        });

        it('hosted to local, the local run failed: the reply stays hosted, with the rounds it came in with', () => {
          const result = buckets([
            {
              ...reply(at, { inputTokens: 1000, outputTokens: 200 }, HOSTED),
              error: 'the server fell over',
              rounds: [round(HOSTED, { inputTokens: 1000, outputTokens: 200 })],
            },
          ]);
          expect(result).toEqual([]);
        });

        it('local to hosted, the hosted run aborted: the local spend is kept', () => {
          const result = buckets([
            {
              ...reply(at, { inputTokens: 400, outputTokens: 40 }, OLLAMA),
              stopReason: 'aborted',
              rounds: [
                round(OLLAMA, { inputTokens: 300, outputTokens: 30 }),
                round(HOSTED, { inputTokens: 100, outputTokens: 10 }),
              ],
            },
          ]);
          expect(
            result.map(bucket => [bucket.model, bucket.replies, bucket.outputTokens, bucket.contextTokens])
          ).toEqual([[OLLAMA, 1, 30, 300]]);
        });

        it('a legacy hosted reply continued locally, with only the later rounds stamped: the earlier tokens are not local', () => {
          const snapshot = { model: OLLAMA, inputTokens: 10, overhead: [] };
          const result = buckets([
            {
              ...reply(at, { inputTokens: 3060, outputTokens: 207 }, null),
              contextSnapshot: snapshot,
              rounds: [
                round(undefined, { inputTokens: 3000, outputTokens: 200 }),
                round(OLLAMA, { inputTokens: 60, outputTokens: 7 }),
              ],
            },
          ]);
          expect(result.map(bucket => [bucket.model, bucket.outputTokens, bucket.contextTokens])).toEqual([
            [OLLAMA, 7, 60],
          ]);
        });

        it('a hosted reply with no stored rounds, continued locally: its earlier tokens stay hosted', () => {
          const result = buckets([
            {
              ...reply(at, { inputTokens: 1060, outputTokens: 207 }, HOSTED),
              rounds: [round(HOSTED), round(OLLAMA, { inputTokens: 60, outputTokens: 7 })],
            },
          ]);
          expect(
            result.map(bucket => [bucket.model, bucket.replies, bucket.outputTokens, bucket.contextTokens])
          ).toEqual([[OLLAMA, 0, 7, 60]]);
        });
      });

      it('keeps only the local share of a reply that also ran on a hosted model', () => {
        const result = buckets([
          {
            // The 500 output tokens no round carries are an explore sub-loop's, which only a hosted turn runs.
            ...reply(at, { inputTokens: 3000, outputTokens: 560 }),
            rounds: [
              round(OLLAMA, { inputTokens: 1000, outputTokens: 20 }),
              round('claude-sonnet-5', { outputTokens: 40 }),
            ],
          },
        ]);
        expect(result.map(bucket => [bucket.model, bucket.outputTokens, bucket.contextTokens])).toEqual([
          [OLLAMA, 20, 1000],
        ]);
      });

      it('gives what no round carries to the reply model when every round ran locally', () => {
        const result = buckets([
          {
            // A reply stored without rounds and continued on another server: the earlier 500 tokens ride
            // on a usage-less fallback round that keeps the original model.
            ...reply(at, { inputTokens: 900, outputTokens: 90 }, OLLAMA),
            rounds: [round(OLLAMA), round(SERVER, { inputTokens: 400, outputTokens: 40 })],
          },
        ]);
        expect(result.map(bucket => [bucket.model, bucket.outputTokens, bucket.contextTokens])).toEqual([
          [SERVER, 40, 400],
          [OLLAMA, 50, 500],
        ]);
        expect(totals(result)).toEqual({ outputTokens: 90, contextTokens: 900 });
      });
    });

    describe('a reply continued in a later hour', () => {
      const began = '2026-10-30T09:05:00.000Z';
      const round = (model: string, endedAt: string | null, usage: ChatUsage) => ({
        text: 'x',
        toolCallIds: [],
        model,
        usage,
        ...(endedAt ? { timing: { startedAt: Date.parse(endedAt) - 1000, endedAt: Date.parse(endedAt) } } : {}),
      });
      const hourly = (result: LocalUsageBucket[], iso: string) =>
        result.find(bucket => bucket.hour === Date.parse(iso));

      it('puts each round in the hour it ended and the reply in the hour it was first stored', () => {
        const result = buckets([
          {
            ...reply(began, {
              inputTokens: 300,
              outputTokens: 30,
              rate: { evalTokens: 30, evalMs: 600, loadMs: 300 },
            }),
            rounds: [
              round(OLLAMA, '2026-10-30T09:06:00.000Z', {
                inputTokens: 100,
                outputTokens: 10,
                rate: { evalTokens: 10, evalMs: 200, loadMs: 200 },
              }),
              round(OLLAMA, '2026-11-02T14:10:00.000Z', {
                inputTokens: 200,
                outputTokens: 20,
                rate: { evalTokens: 20, evalMs: 400, loadMs: 100 },
              }),
            ],
          },
        ]);
        expect(result).toHaveLength(2);
        expect(hourly(result, '2026-10-30T09:00:00.000Z')).toMatchObject({
          replies: 1,
          outputTokens: 10,
          contextTokens: 100,
          timedReplies: 1,
          evalTokens: 10,
          evalMs: 200,
          loads: 1,
          loadMs: 300,
        });
        expect(hourly(result, '2026-11-02T14:00:00.000Z')).toMatchObject({
          replies: 0,
          outputTokens: 20,
          contextTokens: 200,
          timedReplies: 0,
          evalTokens: 20,
          evalMs: 400,
          loads: 0,
          loadMs: 0,
        });

        const lastDay = localUsageWindow(result, 'last-24-hours', NOW, NAMES);
        expect(lastDay.totals).toMatchObject({ outputTokens: 20, replies: 0 });
        expect(lastDay.bars[22]).toMatchObject({ startsAt: '2026-11-02T14:00:00.000Z', outputTokens: 20 });
        expect(lastDay.allTimeReplies).toBe(1);
      });

      it('follows a round on another model to the hour it ended', () => {
        const result = buckets([
          {
            ...reply(began, { outputTokens: 30 }),
            rounds: [
              round(OLLAMA, '2026-10-30T09:06:00.000Z', { outputTokens: 10 }),
              round(SERVER, '2026-11-02T14:10:00.000Z', { outputTokens: 20 }),
            ],
          },
        ]);
        expect(result.map(bucket => [bucket.model, bucket.hour, bucket.replies, bucket.outputTokens])).toEqual([
          [OLLAMA, Date.parse('2026-10-30T09:00:00.000Z'), 1, 10],
          [SERVER, Date.parse('2026-11-02T14:00:00.000Z'), 0, 20],
        ]);
      });

      it('keeps a round with no timing, and what no round carries, in the hour the reply was first stored', () => {
        const result = buckets([
          {
            ...reply(began, {
              inputTokens: 900,
              outputTokens: 90,
              rate: { evalTokens: 80, evalMs: 1600 },
            }),
            rounds: [
              round(OLLAMA, null, { inputTokens: 200, outputTokens: 20, rate: { evalTokens: 20, evalMs: 400 } }),
              round(OLLAMA, '2026-11-02T14:10:00.000Z', {
                inputTokens: 400,
                outputTokens: 40,
                rate: { evalTokens: 40, evalMs: 800 },
              }),
            ],
          },
        ]);
        expect(result).toHaveLength(2);
        expect(hourly(result, '2026-10-30T09:00:00.000Z')).toMatchObject({
          replies: 1,
          outputTokens: 50,
          contextTokens: 500,
          timedReplies: 1,
          evalTokens: 40,
          evalMs: 800,
        });
        expect(hourly(result, '2026-11-02T14:00:00.000Z')).toMatchObject({
          replies: 0,
          outputTokens: 40,
          contextTokens: 400,
          evalTokens: 40,
          evalMs: 800,
        });
      });
    });

    it('skips hosted replies, replies without usage and unreadable timestamps', () => {
      expect(buckets([reply('2026-11-02T15:05:00.000Z', { outputTokens: 3 }, 'claude-sonnet-5')])).toEqual([]);
      const noUsage: ChatMessage = { id: 'n', role: 'assistant', content: 'x', createdAt: '2026-11-02T15:05:00.000Z' };
      expect(buckets([noUsage, reply('not a date', { outputTokens: 3 })])).toEqual([]);
    });

    it('keeps measured, estimated and untimed replies apart', () => {
      const [bucket] = buckets([
        reply('2026-11-02T15:01:00.000Z', {
          outputTokens: 100,
          rate: { evalTokens: 100, evalMs: 2000, promptTokens: 500, promptMs: 250, loadMs: 1200 },
        }),
        reply('2026-11-02T15:02:00.000Z', {
          outputTokens: 50,
          rate: { evalTokens: 49, evalMs: 1000, estimated: true },
        }),
        reply('2026-11-02T15:03:00.000Z', { outputTokens: 20 }),
        reply('2026-11-02T15:04:00.000Z', {
          outputTokens: 30,
          rate: { evalTokens: 30, evalMs: 600, draftTokens: 20, draftAccepted: 15 },
        }),
      ]);
      expect(bucket).toMatchObject({
        replies: 4,
        outputTokens: 200,
        timedReplies: 2,
        evalTokens: 130,
        evalMs: 2600,
        estimatedReplies: 1,
        estimatedEvalTokens: 49,
        estimatedEvalMs: 1000,
        promptTokens: 500,
        promptMs: 250,
        loads: 1,
        loadMs: 1200,
        draftTokens: 20,
        draftAccepted: 15,
      });
    });
  });

  describe('a reply with timed and estimated rounds', () => {
    const timed = { evalTokens: 100, evalMs: 1000, promptTokens: 50, promptMs: 100, loadMs: 500 };
    const estimated = { evalTokens: 40, evalMs: 800, estimated: true as const };
    const round = (endedAt: string, usage: ChatUsage) => ({
      text: 'x',
      toolCallIds: [],
      usage,
      timing: { startedAt: Date.parse(endedAt) - 1000, endedAt: Date.parse(endedAt) },
    });
    const mixed = (first: string, second: string, order: 'timed-first' | 'estimated-first' = 'timed-first') => {
      const rounds =
        order === 'timed-first'
          ? [round(first, { outputTokens: 100, rate: timed }), round(second, { outputTokens: 40, rate: estimated })]
          : [round(first, { outputTokens: 40, rate: estimated }), round(second, { outputTokens: 100, rate: timed })];
      return {
        ...reply('2026-11-02T14:05:00.000Z', {
          outputTokens: 140,
          // What main stores: the rounds summed, so the estimated flag is an OR.
          rate: {
            evalTokens: 140,
            evalMs: 1800,
            promptTokens: 50,
            promptMs: 100,
            loadMs: 500,
            estimated: true,
          },
        }),
        rounds,
      };
    };
    const expected = {
      replies: 1,
      outputTokens: 140,
      timedReplies: 1,
      evalTokens: 100,
      evalMs: 1000,
      promptTokens: 50,
      promptMs: 100,
      loads: 1,
      loadMs: 500,
      estimatedReplies: 0,
      estimatedEvalTokens: 40,
      estimatedEvalMs: 800,
    };

    it.each([
      ['in one clock hour', '2026-11-02T14:06:00.000Z', '2026-11-02T14:07:00.000Z'],
      ['across hours', '2026-11-02T14:06:00.000Z', '2026-11-02T15:07:00.000Z'],
      ['across hours, the estimated round first', '2026-11-02T15:06:00.000Z', '2026-11-02T14:07:00.000Z'],
    ])('counts the timed round as timed and only the estimated one as estimated, %s', (_, first, second) => {
      const order = first > second ? 'estimated-first' : 'timed-first';
      const result = buckets([mixed(first, second, order)]);
      const total = localUsageWindow(result, 'last-24-hours', NOW, NAMES).totals;
      expect(total).toMatchObject(expected);
    });

    it('counts a reply timed if any round was, and estimated only when every rated round was', () => {
      const at = '2026-11-02T14:06:00.000Z';
      const onlyEstimated = {
        ...reply('2026-11-02T14:05:00.000Z', { outputTokens: 80, rate: { ...estimated, evalTokens: 80 } }),
        rounds: [round(at, { outputTokens: 40, rate: estimated }), round(at, { outputTokens: 40, rate: estimated })],
      };
      const [bucket] = buckets([onlyEstimated]);
      expect(bucket).toMatchObject({ timedReplies: 0, estimatedReplies: 1, evalTokens: 0, estimatedEvalTokens: 80 });
      const [timedOnly] = buckets([mixed(at, at)]);
      expect(timedOnly).toMatchObject({ timedReplies: 1, estimatedReplies: 0 });
    });

    it('counts an unrated round beside a rated one for tokens only, and the reply as timed', () => {
      const at = '2026-11-02T14:06:00.000Z';
      const result = buckets([
        {
          ...reply('2026-11-02T14:05:00.000Z', { outputTokens: 120, rate: timed }),
          rounds: [round(at, { outputTokens: 20 }), round(at, { outputTokens: 100, rate: timed })],
        },
      ]);
      const { totals } = localUsageWindow(result, 'last-24-hours', NOW, NAMES);
      expect(totals).toMatchObject({
        replies: 1,
        outputTokens: 120,
        timedReplies: 1,
        evalTokens: 100,
        evalMs: 1000,
        estimatedReplies: 0,
        estimatedEvalTokens: 0,
        estimatedEvalMs: 0,
      });
    });

    it('counts only the rounds that ended inside the window when the reply began before it', () => {
      const span = (startedAt: string, endedAt: string, usage: ChatUsage) => ({
        text: 'x',
        toolCallIds: [],
        usage,
        timing: { startedAt: Date.parse(startedAt), endedAt: Date.parse(endedAt) },
      });
      const outside = span('2026-11-01T14:30:00.000Z', '2026-11-01T15:50:00.000Z', {
        outputTokens: 60,
        rate: { evalTokens: 60, evalMs: 600 },
      });
      const inside = span('2026-11-01T15:55:00.000Z', '2026-11-01T16:20:00.000Z', {
        outputTokens: 40,
        rate: { evalTokens: 40, evalMs: 400 },
      });
      const result = buckets([
        {
          ...reply('2026-11-01T16:30:00.000Z', { outputTokens: 100, rate: { evalTokens: 100, evalMs: 1000 } }),
          rounds: [outside, inside],
        },
      ]);
      const { totals, allTimeReplies } = localUsageWindow(result, 'last-24-hours', NOW, NAMES);
      expect(totals).toMatchObject({ replies: 1, outputTokens: 40, evalTokens: 40, evalMs: 400 });
      expect(allTimeReplies).toBe(1);
    });
  });

  describe('localUsageWindow', () => {
    function bucket(model: string, at: string, figures: Partial<LocalUsageBucket>): LocalUsageBucket {
      const [made] = sessionUsageBuckets({ model, messages: [reply(at, { outputTokens: 0 }, model)] });
      return { ...made, ...figures };
    }

    it('takes the speed as a ratio of sums, not a mean of per-reply rates', () => {
      // 1000 tokens in 10s and 10 tokens in 1s: a mean of rates would say 55 tok/s, the sums ~91.8.
      const result = localUsageWindow(
        [
          bucket(OLLAMA, '2026-11-02T15:00:00.000Z', { evalTokens: 1000, evalMs: 10_000, timedReplies: 1 }),
          bucket(OLLAMA, '2026-11-02T14:00:00.000Z', { evalTokens: 10, evalMs: 1000, timedReplies: 1 }),
        ],
        'last-24-hours',
        NOW,
        NAMES
      );
      expect((result.totals.evalTokens / result.totals.evalMs) * 1000).toBeCloseTo(91.8, 1);
      expect(result.byModel[0]).toMatchObject({ evalTokens: 1010, evalMs: 11_000 });
    });

    it('draws 24 UTC hour bars ending in the current hour, and drops buckets outside them', () => {
      const result = localUsageWindow(
        [
          bucket(OLLAMA, '2026-11-02T15:10:00.000Z', { outputTokens: 7 }),
          bucket(OLLAMA, '2026-11-01T16:59:00.000Z', { outputTokens: 3 }),
          bucket(OLLAMA, '2026-11-01T15:59:00.000Z', { outputTokens: 1000 }),
          bucket(OLLAMA, '2026-11-02T16:00:00.000Z', { outputTokens: 1000 }),
        ],
        'last-24-hours',
        NOW,
        NAMES
      );
      expect(result.granularity).toBe('hour');
      expect(result.bars).toHaveLength(24);
      expect(result.bars[0]).toMatchObject({ startsAt: '2026-11-01T16:00:00.000Z', outputTokens: 3, replies: 1 });
      expect(result.bars[23]).toMatchObject({ startsAt: '2026-11-02T15:00:00.000Z', outputTokens: 7 });
      expect(result.totals.outputTokens).toBe(10);
      expect(result.totals.replies).toBe(2);
      expect(result.allTimeReplies).toBe(4);
    });

    it('draws the 30-day window as UTC days, like the credit chart', () => {
      const result = localUsageWindow(
        [
          bucket(OLLAMA, '2026-10-03T00:00:00.000Z', { outputTokens: 5 }),
          bucket(OLLAMA, '2026-10-02T23:00:00.000Z', { outputTokens: 1000 }),
          bucket(OLLAMA, '2026-11-02T01:00:00.000Z', { outputTokens: 2 }),
          bucket(OLLAMA, '2026-11-02T14:00:00.000Z', { outputTokens: 2 }),
        ],
        'last-30-days',
        NOW,
        NAMES
      );
      expect(result.bars).toHaveLength(31);
      expect(result.bars[0]).toMatchObject({ startsAt: '2026-10-03T00:00:00.000Z', outputTokens: 5 });
      expect(result.bars[30]).toMatchObject({ startsAt: '2026-11-02T00:00:00.000Z', outputTokens: 4, replies: 2 });
      expect(result.totals.outputTokens).toBe(9);
    });

    it('breaks down by model name across servers, and by server name', () => {
      const result = localUsageWindow(
        [
          bucket(OLLAMA, '2026-11-02T15:00:00.000Z', { outputTokens: 10 }),
          bucket('local:srv-box:llama3.2', '2026-11-02T15:00:00.000Z', { outputTokens: 30 }),
          bucket(SERVER, '2026-11-02T14:00:00.000Z', { outputTokens: 5 }),
          bucket('local:srv-gone:qwen3', '2026-11-02T14:00:00.000Z', { outputTokens: 1 }),
          bucket('local:srv-old:qwen3', '2026-11-02T14:00:00.000Z', { outputTokens: 1 }),
        ],
        'last-24-hours',
        NOW,
        NAMES
      );
      expect(result.byModel.map(row => [row.label, row.outputTokens, row.replies])).toEqual([
        ['llama3.2', 40, 2],
        ['qwen3', 7, 3],
      ]);
      expect(result.byServer.map(row => [row.label, row.outputTokens])).toEqual([
        ['Studio box', 35],
        ['This computer', 10],
        ['Removed server', 2],
      ]);
    });
  });

  describe('the removed server row', () => {
    function bucket(model: string, at: string, figures: Partial<LocalUsageBucket>): LocalUsageBucket {
      const [made] = sessionUsageBuckets({ model, messages: [reply(at, { outputTokens: 0 }, model)] });
      return { ...made, ...figures };
    }

    it('is matched by id, so a saved server named like it keeps its own row', () => {
      const named = new Map([
        ['box', 'Removed server'],
        ['other', 'Studio box'],
      ]);
      const result = localUsageWindow(
        [
          bucket(SERVER, '2026-11-02T14:00:00.000Z', { outputTokens: 5 }),
          bucket('local:srv-gone:qwen3', '2026-11-02T14:00:00.000Z', { outputTokens: 1 }),
        ],
        'last-24-hours',
        NOW,
        named
      );
      expect(result.byServer.map(row => [row.key, row.label, row.outputTokens])).toEqual([
        ['srv-box', 'Removed server', 5],
        ['removed', 'Removed server', 1],
      ]);
    });
  });

  describe('serverLabel', () => {
    it('names this computer, a saved server, and one that was removed', () => {
      expect(serverLabel('ollama', NAMES)).toBe('This computer');
      expect(serverLabel('srv-box', NAMES)).toBe('Studio box');
      expect(serverLabel('srv-gone', NAMES)).toBe('Removed server');
    });

    it('keeps the runtime id when the saved servers could not be read', () => {
      expect(serverLabel('ollama', null)).toBe('This computer');
      expect(serverLabel('srv-box', null)).toBe('srv-box');
    });
  });
});

describe('usageBuckets', () => {
  const NOON = new Date('2026-10-07T12:34:56.000Z');

  describe('hourlyBars', () => {
    it('covers every hour of the window, including the ones that spent nothing', () => {
      const bars = hourlyBars([], NOON);
      expect(bars).toHaveLength(24);
      expect(bars.every(bar => bar.creditsSpent === 0 && bar.requests === 0)).toBe(true);
    });

    // The ledger stores usage as a negative credit; a chart of negative bars would be upside down.
    it('charts the magnitude of a deduction, not its sign', () => {
      const at = new Date(NOON.getTime() - 60_000).toISOString();
      const bars = hourlyBars([{ createdAt: at, credits: -42 }], NOON);
      expect(bars[23]).toMatchObject({ creditsSpent: 42, requests: 1 });
    });

    it('adds up every row that falls in one hour', () => {
      const rows = [
        { createdAt: new Date(NOON.getTime() - 60_000).toISOString(), credits: -3 },
        { createdAt: new Date(NOON.getTime() - 120_000).toISOString(), credits: -7 },
      ];
      expect(sumBars(hourlyBars(rows, NOON))).toEqual({ creditsSpent: 10, requests: 2 });
    });

    it('drops rows outside the window rather than folding them into an edge bucket', () => {
      const old = new Date(NOON.getTime() - 48 * 3_600_000).toISOString();
      const ahead = new Date(NOON.getTime() + 3_600_000).toISOString();
      const bars = hourlyBars(
        [
          { createdAt: old, credits: -5 },
          { createdAt: ahead, credits: -5 },
        ],
        NOON
      );
      expect(sumBars(bars)).toEqual({ creditsSpent: 0, requests: 0 });
    });

    it('ignores a row the server shaped unexpectedly instead of charting a NaN', () => {
      const at = new Date(NOON.getTime() - 60_000).toISOString();
      const bars = hourlyBars(
        [
          { createdAt: at, credits: '-5' },
          { createdAt: null, credits: -5 },
        ],
        NOON
      );
      expect(sumBars(bars)).toEqual({ creditsSpent: 0, requests: 0 });
    });
  });

  describe('dailyBars', () => {
    // The server's window starts at this clock time `days` ago, so its first bucket is a partial
    // UTC day. Spanning it is what keeps the totals above the chart equal to what the chart draws.
    it('spans every UTC day the server window touches', () => {
      const bars = dailyBars([], NOON, 30);
      expect(bars).toHaveLength(31);
      expect(bars[0].startsAt).toBe('2026-09-07T00:00:00.000Z');
      expect(bars[30].startsAt).toBe('2026-10-07T00:00:00.000Z');
    });

    it('fills the days the server reported nothing for with zero', () => {
      const bars = dailyBars([{ day: '2026-10-06', creditsCharged: 120, requests: 4 }], NOON, 30);
      expect(bars[29]).toMatchObject({ creditsSpent: 120, requests: 4 });
      expect(bars[28].creditsSpent).toBe(0);
    });

    it('keeps a day the server reported as zero spend, which is a real answer', () => {
      const bars = dailyBars([{ day: '2026-10-07', creditsCharged: 0, requests: 0 }], NOON, 1);
      expect(bars.at(-1)).toMatchObject({ creditsSpent: 0, requests: 0 });
    });
  });

  describe('breakdown rows', () => {
    it('labels a model by its id and keeps the provider as the secondary line', () => {
      const rows = modelRows([{ provider: 'anthropic', model: 'claude-opus-5', creditsCharged: 9, requests: 2 }]);
      expect(rows).toEqual([
        { key: 'anthropic:claude-opus-5', label: 'claude-opus-5', detail: 'anthropic', creditsSpent: 9, requests: 2 },
      ]);
    });

    it('turns the wire slugs into something readable', () => {
      expect(humanize('agent_execution')).toBe('Agent execution');
      expect(featureRows([{ feature: 'agent_execution', creditsCharged: 4, requests: 1 }])[0].label).toBe(
        'Agent execution'
      );
    });

    // The by-source cut comes off the ledger, which names its spend differently from the rest.
    it('reads the by-source cut from creditsSpent', () => {
      expect(sourceRows([{ source: 'desktop', creditsSpent: 11, requests: 3 }])[0]).toMatchObject({
        label: 'Desktop',
        creditsSpent: 11,
      });
    });

    it('does not drop a row the server left a field off', () => {
      expect(modelRows([{ creditsCharged: 5 }])[0]).toMatchObject({ label: 'Unknown model', requests: 0 });
    });
  });
});
