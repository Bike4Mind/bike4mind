import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../chat/SessionStore';
import type { LocalUsageBucket } from './localUsage';
import { LocalUsageService, type LocalUsageServiceDeps } from './LocalUsageService';

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
  const buckets = vi.fn(async () => [bucket(10)]);
  const deps: LocalUsageServiceDeps = {
    logger: { warn: vi.fn() },
    buckets,
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

    advance(60_000);
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

  it('refuses an unknown window and reports a failed read without caching it', async () => {
    const failing = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValue([bucket(1)]);
    const { service: usage } = service({ buckets: failing });
    expect(await usage.usage('last-year' as never)).toEqual({ ok: false, error: 'Unknown usage window.' });
    expect(await usage.usage('last-24-hours')).toMatchObject({ ok: false });
    expect(await usage.usage('last-24-hours')).toMatchObject({ ok: true });
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
      buckets: () => store.localUsageBuckets(),
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
      ['LocalUsageService.ts', 'localUsage.ts'].map(name => readFile(join(__dirname, name), 'utf8'))
    );
    for (const source of sources) {
      const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
      expect(imports.every(path => path.startsWith('@shared/') || path === './localUsage')).toBe(true);
      expect(source).not.toMatch(/\bfetch\(|axios|client-auth|electron/);
    }
  });
});
