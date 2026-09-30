import { describe, it, expect } from 'vitest';
import { classifySlackPost, parseSlackPost } from '../qa-backfill-slack.mjs';
import { CHANNEL, e2ePost, latencyPost, latencyRow } from './fixtures/slack-posts.mjs';

const ctx = { product: 'product-a', channel: CHANNEL };

describe('parseSlackPost: E2E', () => {
  it('builds the snake_case ingest body from identity, counts, suites and credits', () => {
    expect(parseSlackPost(e2ePost(), ctx)).toEqual({
      product: 'product-a',
      suite: 'Core',
      env: 'staging',
      branch: 'main',
      trigger: 'Run via Deployer',
      source: 'slack-backfill',
      ci_run_url: 'https://github.com/example/repo/actions/runs/555',
      sha: '',
      started_at: new Date(1790000000000).toISOString(),
      duration_ms: 0,
      counts: { passed: 81, failed: 1, skipped: 0, not_started: 0, ran: 82, total: 82 },
      suite_summary: [
        { name: 'Suite A', passed: 3, ran: 4, not_run: 0 },
        { name: 'Suite B', passed: 78, ran: 78, not_run: 0 },
        { name: 'Suite C', passed: 0, ran: 0, not_run: 2 },
      ],
      // Same threshold as the CI ingest (CREDITS_THRESHOLD), not the 30 the post prints.
      metrics: [
        { kind: 'credits', model: 'model-x', value: 12.5, unit: 'credits', threshold: 60 },
        { kind: 'credits', model: 'Model Y Mini', value: 75, unit: 'credits', threshold: 60 },
      ],
      external_run_id: `slack-${CHANNEL}-1790000000.000100`,
      tests: [],
    });
  });

  it('maps the unnamed suite to Full and passes the tenant through', () => {
    const run = parseSlackPost(e2ePost({ suite: null, trigger: 'Manual', credits: null }), { ...ctx, tenant: 'tenant-a' });
    expect(run).toMatchObject({ suite: 'Full', trigger: 'Manual', tenant: 'tenant-a', metrics: [] });
  });

  it('keeps not-started counts so the server derives infra-error', () => {
    const run = parseSlackPost(e2ePost({ results: { passed: 81, failed: 0, skipped: 0, notStarted: 5, total: 81 } }), ctx);
    expect(run.counts.not_started).toBe(5);
  });

  it('stores a run that died before Playwright reported as zero counts', () => {
    const run = parseSlackPost(
      e2ePost({
        status: ':x: No results (run failed before tests)',
        results: { passed: 0, failed: 0, skipped: 0, notStarted: 0, total: 0 },
        summary: ['_No results available_'],
        credits: ['_No credits data available_'],
      }),
      ctx
    );
    expect(run).toMatchObject({ counts: { ran: 0, total: 0 }, suite_summary: [], metrics: [] });
  });

  it('takes ran from the suite lines, like the CI script, when a setup failure clamps skipped', () => {
    const run = parseSlackPost(
      e2ePost({ results: { passed: 3, failed: 2, skipped: 0, notStarted: 0, total: 5 }, summary: [':red_circle: Suite A: 3/4'] }),
      ctx
    );
    expect(run.counts).toMatchObject({ ran: 4, total: 5 });
  });

  it('decodes the HTML entities Slack stores for &, < and >', () => {
    const run = parseSlackPost(e2ePost({ branch: 'feat/a&amp;b', env: 'Staging &lt;2&gt;' }), ctx);
    expect(run).toMatchObject({ branch: 'feat/a&b', env: 'staging <2>' });
  });

  it('derives a stable id from channel + ts, so re-parsing the same post upserts one run', () => {
    const a = parseSlackPost(e2ePost(), ctx);
    expect(parseSlackPost(e2ePost(), ctx).external_run_id).toBe(a.external_run_id);
    expect(parseSlackPost(e2ePost({ ts: '1790000000.000200' }), ctx).external_run_id).not.toBe(a.external_run_id);
    expect(parseSlackPost(e2ePost(), { ...ctx, channel: 'C0OTHER' }).external_run_id).not.toBe(a.external_run_id);
  });
});

describe('parseSlackPost: AI Latency', () => {
  it('counts one result per cell and mirrors the CI latency metrics', () => {
    const run = parseSlackPost(latencyPost(), ctx);
    expect(run).toMatchObject({
      suite: 'AI Latency',
      env: 'staging',
      trigger: 'Run via Schedule',
      ci_run_url: 'https://github.com/example/repo/actions/runs/777',
      counts: { passed: 2, failed: 1, skipped: 0, not_started: 1, ran: 3, total: 3 },
      suite_summary: [],
      external_run_id: `slack-${CHANNEL}-1790000500.000200`,
      tests: [],
    });
    expect(run.metrics).toEqual([
      { kind: 'latency', model: 'model-x', label: 'latency-spec-a', value: 3.2, unit: 's', threshold: 5 },
      { kind: 'latency', model: 'Model Y Mini', label: 'latency-spec-a', value: 7.1, unit: 's', threshold: 5 },
      { kind: 'latency', model: 'Model Y Mini', label: 'latency-spec-b', value: 4, unit: 's' },
    ]);
  });

  it('reads an entity-escaped threshold and a model name that overflows its column', () => {
    const row = latencyRow('latency-spec-a', 'A Very Long Model Name Here', 'Pass', '3.20s / &lt;=7.5s');
    const run = parseSlackPost(latencyPost({ rows: [row] }), ctx);
    expect(run.metrics).toEqual([
      { kind: 'latency', model: 'A Very Long Model Name Here', label: 'latency-spec-a', value: 3.2, unit: 's', threshold: 7.5 },
    ]);
  });
});

describe('classifySlackPost: everything else is logged, never guessed', () => {
  it('skips a preview run that could not start, as the CI ingest does', () => {
    const status = ':fast_forward: Skipped (E2E_CLEANUP_SECRET not configured)';
    expect(classifySlackPost(e2ePost({ status }), ctx)).toEqual({ kind: 'skipped', reason: expect.stringMatching(/preview/) });
    expect(classifySlackPost(latencyPost({ status }), ctx).kind).toBe('skipped');
    expect(parseSlackPost(e2ePost({ status }), ctx)).toBeNull();
  });

  const renamed = e2ePost();
  renamed.blocks[0].text.text = 'Deploy finished (Run via Deployer)';

  const unparseable = [
    ['a post with no blocks', { type: 'message', bot_id: 'B0TEST', ts: '1790000000.000100', text: 'deploy finished', blocks: [] }, /no header/],
    ['an unknown header', renamed, /unknown header/],
    ['an older format without the run link', e2ePost({ runUrl: null }), /no Actions run link/],
    ['a run link that is not an Actions run', e2ePost({ runUrl: 'https://example.com/report' }), /no Actions run link/],
    ['a changed Results line', e2ePost({ results: { passed: 'many', failed: 0, skipped: 0, notStarted: 0, total: 1 } }), /Results/],
    ['a suite line in another shape', e2ePost({ summary: ['Suite A passed 3 of 4'] }), /bad suite line/],
    ['a credits line in another shape', e2ePost({ credits: ['model-x used 12 credits'] }), /bad credits line/],
    ['a latency cell in another shape', latencyPost({ rows: [latencyRow('latency-spec-a', 'model-x', 'Pass', '3.2 seconds')] }), /bad latency cell/],
    ['a latency row without a quality token', latencyPost({ rows: ['latency-spec-a model-x 3.20s'] }), /bad latency row/],
    ['a latency table with no rows', latencyPost({ rows: [] }), /no rows/],
    ['a post missing its ts', { ...e2ePost(), ts: undefined }, /no message ts/],
  ];
  it.each(unparseable)('%s', (_name, message, reason) => {
    expect(classifySlackPost(message, ctx)).toEqual({ kind: 'unparseable', reason: expect.stringMatching(reason) });
    expect(parseSlackPost(message, ctx)).toBeNull();
  });
});
