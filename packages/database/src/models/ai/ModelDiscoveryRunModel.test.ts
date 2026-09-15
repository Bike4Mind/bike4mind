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

  it('round-trips the per-model detail the report is read for', async () => {
    const created = await ModelDiscoveryRun.create(
      run({
        changes: { added: ['claude-y'], flagged: ['gpt-5.6-luna', 'claude-y'], operatorConflicts: ['claude-y'] },
        priceFlags: [
          {
            modelId: 'gpt-5.6-luna',
            kind: 'source-disagreement',
            proposed: { inputPerMTok: 0.2, outputPerMTok: 1.2 },
            current: { inputPerMTok: 1, outputPerMTok: 6 },
            sources: ['models.dev', 'litellm'],
            detail: 'sources disagree beyond 10%: models.dev in 0.2/out 1.2 vs litellm in 1/out 6; applied neither',
          },
        ],
        priceRows: [
          {
            modelId: 'claude-y',
            unit: 'per_token',
            inputPerMTok: 3,
            outputPerMTok: 15,
            effectiveFrom: new Date('2026-07-01T00:00:00Z'),
            sources: ['anthropic'],
            note: 'discovery:anthropic@2026-07-01T00:00:00.000Z',
          },
        ],
        priceOverrides: [
          {
            modelId: 'claude-y',
            source: 'anthropic',
            dissenting: ['litellm'],
            applied: { inputPerMTok: 3, outputPerMTok: 15 },
            detail: 'anthropic publishes in 3/out 15 $/MTok and litellm in 8/out 24 $/MTok disagree beyond 10%',
          },
        ],
        priceSkips: [{ modelId: 'claude-x', reason: 'unchanged' }],
        lifecycleTransitions: [
          { modelId: 'claude-x', from: 'active', to: 'deprecated', signal: 'absence', autoApplied: false },
        ],
        catalogDiff: [
          {
            modelId: 'claude-y',
            kind: 'added',
            ownedGroups: ['identity', 'limits'],
            changedKeys: ['contextWindow'],
            lifecycleStatus: 'active',
            promoted: true,
            blockedBy: [],
            operatorOwned: false,
          },
        ],
      })
    );

    const stored = await modelDiscoveryRunRepository.runById(created.id);

    // The sentence is the whole point: it used to reach only logger.warn, which
    // left the admin card saying "flagged" with nowhere to learn why.
    expect(stored?.priceFlags?.[0]).toMatchObject({
      modelId: 'gpt-5.6-luna',
      kind: 'source-disagreement',
      proposed: { inputPerMTok: 0.2, outputPerMTok: 1.2 },
      current: { inputPerMTok: 1, outputPerMTok: 6 },
      detail: 'sources disagree beyond 10%: models.dev in 0.2/out 1.2 vs litellm in 1/out 6; applied neither',
    });
    expect(stored?.priceRows?.[0]).toMatchObject({ modelId: 'claude-y', unit: 'per_token', inputPerMTok: 3 });
    expect(stored?.priceRows?.[0].effectiveFrom).toEqual(new Date('2026-07-01T00:00:00Z'));
    expect(stored?.priceOverrides?.[0]).toMatchObject({
      modelId: 'claude-y',
      source: 'anthropic',
      dissenting: ['litellm'],
      applied: { inputPerMTok: 3, outputPerMTok: 15 },
    });
    expect(stored?.priceSkips).toMatchObject([{ modelId: 'claude-x', reason: 'unchanged' }]);
    expect(stored?.lifecycleTransitions?.[0]).toMatchObject({ modelId: 'claude-x', to: 'deprecated' });
    expect(stored?.catalogDiff?.[0]).toMatchObject({ modelId: 'claude-y', kind: 'added', promoted: true });
    // Both halves of the queue: the merged array the card counts, and the operator
    // overlaps on their own.
    expect(stored?.changes?.flagged).toEqual(['gpt-5.6-luna', 'claude-y']);
    expect(stored?.changes?.operatorConflicts).toEqual(['claude-y']);
    expect(stored?.id).toBe(created.id);
    // The list carries counts, not bodies: six bounded detail arrays per run over
    // twenty runs is megabytes on an endpoint the status card polls.
    const listed = (await modelDiscoveryRunRepository.recentRuns(1))[0];
    expect(listed.priceFlags).toBeUndefined();
    expect(listed.priceOverrides).toBeUndefined();
    expect(listed.catalogDiff).toBeUndefined();
    expect(listed.changes?.flagged).toEqual(['gpt-5.6-luna', 'claude-y']);
  });

  it('records the mode the run was allowed to act in', async () => {
    // The report is read long after the run, and modelDiscoveryMode can change in
    // between: a report-mode run plans rows and writes none by design, so only the
    // stored mode separates that from a write run whose appends threw.
    const reported = await ModelDiscoveryRun.create(run({ mode: 'report' }));
    const written = await ModelDiscoveryRun.create(run({ mode: 'write', startedAt: new Date('2026-07-02T00:00:00Z') }));

    expect((await modelDiscoveryRunRepository.runById(reported.id))?.mode).toBe('report');
    expect((await modelDiscoveryRunRepository.runById(written.id))?.mode).toBe('write');
    // The list carries it too: the run history picker labels each entry.
    expect((await modelDiscoveryRunRepository.recentRuns(2)).map(entry => entry.mode)).toEqual(['write', 'report']);
  });

  it('records what a truncated detail array was cut from, and nothing when nothing was cut', async () => {
    const cut = await ModelDiscoveryRun.create(run({ detailTotals: { priceFlags: 260, catalogDiff: 301 } }));
    const whole = await ModelDiscoveryRun.create(run({ startedAt: new Date('2026-07-02T00:00:00Z') }));

    expect((await modelDiscoveryRunRepository.runById(cut.id))?.detailTotals).toMatchObject({
      priceFlags: 260,
      catalogDiff: 301,
    });
    expect((await modelDiscoveryRunRepository.runById(whole.id))?.detailTotals).toBeUndefined();
  });

  it('defaults every detail path the type declares non-optional', async () => {
    // lean() skips defaults for paths a document does not carry, so a subdoc
    // written without one would come back undefined while IModelDiscoveryRun
    // promises a value - and the report reads these arrays without guarding.
    const created = await ModelDiscoveryRun.create(
      run({
        priceFlags: [
          {
            modelId: 'gpt-bare',
            kind: 'band-exceeded',
            proposed: { inputPerMTok: 1, outputPerMTok: 2 },
            detail: 'moved beyond the band',
          },
        ],
        priceRows: [
          {
            modelId: 'gpt-bare',
            unit: 'per_token',
            inputPerMTok: 1,
            outputPerMTok: 2,
            effectiveFrom: new Date('2026-07-01T00:00:00Z'),
          },
        ],
        priceOverrides: [
          {
            modelId: 'gpt-bare',
            source: 'openai',
            applied: { inputPerMTok: 1, outputPerMTok: 2 },
            detail: 'the provider value wins',
          },
        ],
        lifecycleTransitions: [{ modelId: 'gpt-bare', to: 'deprecated', signal: 'absence' }],
        catalogDiff: [{ modelId: 'gpt-bare', kind: 'updated' }],
      })
    );

    const stored = await modelDiscoveryRunRepository.runById(created.id);

    expect(stored?.priceFlags?.[0].sources).toEqual([]);
    expect(stored?.priceRows?.[0]).toMatchObject({ sources: [], note: '' });
    expect(stored?.priceOverrides?.[0].dissenting).toEqual([]);
    expect(stored?.lifecycleTransitions?.[0].autoApplied).toBe(false);
    expect(stored?.catalogDiff?.[0]).toMatchObject({
      ownedGroups: [],
      changedKeys: [],
      blockedBy: [],
      promoted: false,
      operatorOwned: false,
      lifecycleStatus: 'unknown',
    });
  });

  it('keeps parsing a run written before the detail fields existed', async () => {
    const created = await ModelDiscoveryRun.create(run());

    const stored = await modelDiscoveryRunRepository.runById(created.id);

    expect(stored?.priceFlags ?? []).toEqual([]);
    expect(stored?.priceOverrides ?? []).toEqual([]);
    expect(stored?.catalogDiff ?? []).toEqual([]);
  });

  it('lists the newest runs first, up to the limit', async () => {
    for (const day of ['01', '02', '03']) {
      await ModelDiscoveryRun.create(run({ startedAt: new Date(`2026-07-${day}T00:00:00Z`) }));
    }
    await ModelDiscoveryRun.create(run({ startedAt: new Date('2026-07-04T00:00:00Z'), host: 'selfhost' }));

    const recent = await modelDiscoveryRunRepository.recentRuns(2);
    expect(recent.map(entry => entry.startedAt)).toEqual([
      new Date('2026-07-04T00:00:00Z'),
      new Date('2026-07-03T00:00:00Z'),
    ]);
    // The list is addressed by id, so a run without one is a run nobody can open.
    expect(recent.every(entry => typeof entry.id === 'string' && entry.id.length > 0)).toBe(true);
    expect((await modelDiscoveryRunRepository.recentRuns(20, 'hosted')).map(entry => entry.host)).toEqual([
      'hosted',
      'hosted',
      'hosted',
    ]);
    // The head of the list is the run the status card reads.
    expect(recent[0].startedAt).toEqual((await modelDiscoveryRunRepository.latestRun())?.startedAt);
  });

  it('has no run to open for an unknown or malformed id', async () => {
    // A runId out of a query string is whatever the caller typed: a CastError
    // here would be a 500 on what is really a 404.
    expect(await modelDiscoveryRunRepository.runById('not-an-object-id')).toBeNull();
    expect(await modelDiscoveryRunRepository.runById('68000000000000000000000a')).toBeNull();
  });

  it('expires run reports after 90 days', () => {
    const ttl = ModelDiscoveryRun.schema.indexes().find(([, options]) => options.expireAfterSeconds !== undefined);
    expect(ttl?.[0]).toEqual({ startedAt: 1 });
    expect(ttl?.[1].expireAfterSeconds).toBe(90 * 24 * 60 * 60);
  });
});
