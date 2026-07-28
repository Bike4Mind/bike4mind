import { describe, it, expect, beforeEach } from 'vitest';
import { ModelDiscoveryRun, modelDiscoveryRunRepository } from './ModelDiscoveryRunModel';
import { setupMongoTest } from '../../__test__/utils';

const run = (overrides: Record<string, unknown> = {}) => ({
  startedAt: new Date('2026-07-01T00:00:00Z'),
  finishedAt: new Date('2026-07-01T00:01:00Z'),
  trigger: 'cron',
  host: 'hosted',
  status: 'ok',
  sources: [
    { name: 'anthropic', ok: true, durationMs: 120, httpStatus: 200, parserRows: { deprecations: 12, pricing: 30 } },
  ],
  changes: { added: ['claude-y'] },
  ...overrides,
});

describe('ModelDiscoveryRunRepository', () => {
  setupMongoTest();

  beforeEach(async () => {
    await ModelDiscoveryRun.deleteMany({});
  });

  it('round-trips a run report', async () => {
    await ModelDiscoveryRun.create(run({ unmatchedIds: ['grok-z'] }));

    const latest = await modelDiscoveryRunRepository.latestRun();
    expect(latest).toMatchObject({ trigger: 'cron', host: 'hosted', status: 'ok', unmatchedIds: ['grok-z'] });
    expect(latest?.sources?.[0]).toMatchObject({ name: 'anthropic', ok: true, durationMs: 120 });
    // The parser-shift guard compares against this on the next run, so a report
    // that loses it silently disables the guard.
    expect(latest?.sources?.[0].parserRows).toEqual({ deprecations: 12, pricing: 30 });
    expect(latest?.changes?.added).toEqual(['claude-y']);
  });

  it('separates the newest run from the newest successful one, per host', async () => {
    await ModelDiscoveryRun.create(run({ startedAt: new Date('2026-07-01T00:00:00Z'), status: 'ok' }));
    await ModelDiscoveryRun.create(run({ startedAt: new Date('2026-07-02T00:00:00Z'), status: 'failed' }));
    await ModelDiscoveryRun.create(
      run({ startedAt: new Date('2026-07-03T00:00:00Z'), status: 'ok', host: 'selfhost' })
    );

    expect((await modelDiscoveryRunRepository.latestRun('hosted'))?.status).toBe('failed');
    expect((await modelDiscoveryRunRepository.lastSuccessfulRun('hosted'))?.startedAt).toEqual(
      new Date('2026-07-01T00:00:00Z')
    );
    expect((await modelDiscoveryRunRepository.lastSuccessfulRun())?.host).toBe('selfhost');
  });

  it('has no successful run to report on an empty collection (the fallback-seed banner case)', async () => {
    expect(await modelDiscoveryRunRepository.lastSuccessfulRun()).toBeNull();
  });

  it('expires run reports after 90 days', () => {
    const ttl = ModelDiscoveryRun.schema.indexes().find(([, options]) => options.expireAfterSeconds !== undefined);
    expect(ttl?.[0]).toEqual({ startedAt: 1 });
    expect(ttl?.[1].expireAfterSeconds).toBe(90 * 24 * 60 * 60);
  });
});
