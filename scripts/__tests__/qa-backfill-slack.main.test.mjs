import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../qa-backfill-slack.mjs';
import { CHANNEL, e2ePost } from './fixtures/slack-posts.mjs';

const ENV = { QA_INGEST_URL: 'https://app.example.com/', QA_INGEST_KEY: 'b4m_test_key' };
const TOKEN = 'xoxb-test-token';
const noSleep = async () => {};
const makeLog = () => ({ log: vi.fn(), warn: vi.fn() });
const allLogged = log => [...log.log.mock.calls, ...log.warn.mock.calls].flat().join('\n');

const BEFORE = '2026-09-28T00:00:00.000Z';
const at = iso => `${Date.parse(iso) / 1000}.000100`;
const inWindow = at('2026-09-20T00:00:00.000Z');
const later = at('2026-09-21T00:00:00.000Z');
const tooOld = at('2026-08-01T00:00:00.000Z');
const tooNew = at('2026-09-28T01:00:00.000Z');
const baseArgs = ['--product', 'product-a', '--channel', CHANNEL, '--before', BEFORE];

async function inputFile(messages) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-backfill-'));
  const file = path.join(dir, 'history.json');
  await fs.writeFile(file, JSON.stringify({ ok: true, messages }));
  return file;
}

// The slice of fetch's Response that qa-backfill-slack.mjs reads.
const json = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const ingested = (created = true) => json({ run_id: 'r1', status: 'passed', created });
const ingestCalls = fetch => fetch.mock.calls.filter(([u]) => String(u).endsWith('/api/qa/runs'));

describe('backfill main', () => {
  it('posts parseable bot posts inside the window, oldest first, and logs every other bot post', async () => {
    const file = await inputFile([
      e2ePost({ ts: later }),
      e2ePost({ ts: inWindow }),
      e2ePost({ ts: tooOld }),
      e2ePost({ ts: tooNew }),
      e2ePost({ ts: inWindow, status: ':fast_forward: Skipped (E2E_CLEANUP_SECRET not configured)' }),
      { type: 'message', user: 'U0TEST', ts: inWindow, text: 'looking into it' },
      { type: 'message', bot_id: 'B0TEST', ts: inWindow, text: 'deploy done', blocks: [] },
    ]);
    const fetch = vi.fn(async () => ingested());
    const log = makeLog();
    expect(await main([...baseArgs, '--input', file], ENV, { fetch, sleep: noSleep, log })).toBe(0);

    const calls = ingestCalls(fetch);
    expect(calls).toHaveLength(2);
    const [url, init] = calls[0];
    expect(url).toBe('https://app.example.com/api/qa/runs');
    expect(init.headers['x-api-key']).toBe('b4m_test_key');
    expect(calls.map(([, i]) => JSON.parse(i.body).external_run_id)).toEqual([
      `slack-${CHANNEL}-${inWindow}`,
      `slack-${CHANNEL}-${later}`,
    ]);
    expect(JSON.parse(init.body)).toMatchObject({ source: 'slack-backfill', tests: [] });
    expect(log.log).toHaveBeenCalledWith(expect.stringMatching(`unparseable ts=${inWindow}: no header block`));
    expect(log.log).toHaveBeenCalledWith(expect.stringMatching(`skipped ts=${inWindow}: preview`));
    expect(log.log).toHaveBeenLastCalledWith(
      'qa-backfill: messages=7 parsed=2 posted=2 created=2 failed=0 skipped=1 unparseable=1 ignored=3'
    );
    expect(allLogged(log)).not.toContain('b4m_test_key');
  });

  it('upserts the same runs on a re-run: identical bodies, created=false from the server', async () => {
    const file = await inputFile([e2ePost({ ts: inWindow })]);
    const bodies = [];
    for (const created of [true, false]) {
      const fetch = vi.fn(async () => ingested(created));
      const log = makeLog();
      await main([...baseArgs, '--input', file], ENV, { fetch, sleep: noSleep, log });
      bodies.push(ingestCalls(fetch)[0][1].body);
      if (!created) expect(log.log).toHaveBeenLastCalledWith(expect.stringContaining('posted=1 created=0'));
    }
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('prints the parsed runs in dry-run without writing or needing ingest credentials', async () => {
    const file = await inputFile([e2ePost({ ts: inWindow })]);
    const fetch = vi.fn();
    const log = makeLog();
    expect(await main([...baseArgs, '--input', file, '--dry-run'], {}, { fetch, sleep: noSleep, log })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    const line = log.log.mock.calls.map(([m]) => m).find(m => m.startsWith('qa-backfill: would post'));
    expect(JSON.parse(line.slice(line.indexOf('{')))).toMatchObject({ external_run_id: `slack-${CHANNEL}-${inWindow}` });
  });

  it('pages conversations.history for the --channel with the env token, and never logs the token', async () => {
    const fetch = vi.fn(async (url, init) => {
      if (!String(url).startsWith('https://slack.com/api/conversations.history')) return ingested();
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      const page2 = new URL(url).searchParams.get('cursor') === 'c2';
      return json({
        ok: true,
        messages: [e2ePost({ ts: page2 ? later : inWindow })],
        has_more: !page2,
        response_metadata: { next_cursor: page2 ? '' : 'c2' },
      });
    });
    const log = makeLog();
    expect(await main(baseArgs, { ...ENV, SLACK_BOT_TOKEN: TOKEN }, { fetch, sleep: noSleep, log })).toBe(0);
    const slackUrls = fetch.mock.calls.map(([u]) => new URL(u)).filter(u => u.hostname === 'slack.com');
    expect(slackUrls).toHaveLength(2);
    expect(Object.fromEntries(slackUrls[0].searchParams)).toMatchObject({
      channel: CHANNEL,
      latest: String(Date.parse(BEFORE) / 1000),
      oldest: String(Date.parse(BEFORE) / 1000 - 30 * 86400),
    });
    expect(ingestCalls(fetch)).toHaveLength(2);
    expect(allLogged(log)).not.toContain(TOKEN);
  });

  it('waits out a Slack 429 for its Retry-After, then continues', async () => {
    let limited = false;
    const fetch = vi.fn(async url => {
      if (!String(url).includes('slack.com')) return ingested();
      if (!limited) {
        limited = true;
        return json({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '2' });
      }
      return json({ ok: true, messages: [e2ePost({ ts: inWindow })], has_more: false });
    });
    const sleep = vi.fn(noSleep);
    expect(await main(baseArgs, { ...ENV, SLACK_BOT_TOKEN: TOKEN }, { fetch, sleep, log: makeLog() })).toBe(0);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(ingestCalls(fetch)).toHaveLength(1);
  });

  it('exits 1 without posting when Slack refuses the read', async () => {
    const fetch = vi.fn(async () => json({ ok: false, error: 'not_in_channel' }));
    const log = makeLog();
    expect(await main(baseArgs, { ...ENV, SLACK_BOT_TOKEN: TOKEN }, { fetch, sleep: noSleep, log })).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not_in_channel'));
    expect(ingestCalls(fetch)).toHaveLength(0);
    expect(allLogged(log)).not.toContain(TOKEN);
  });

  it('counts a rejected post as failed and exits 1, after retrying a 5xx', async () => {
    const file = await inputFile([e2ePost({ ts: inWindow }), e2ePost({ ts: later })]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json('boom', 503))
      .mockResolvedValueOnce(ingested())
      .mockResolvedValueOnce(json({ error: 'bad' }, 422));
    const log = makeLog();
    expect(await main([...baseArgs, '--input', file], ENV, { fetch, sleep: noSleep, log })).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(log.log).toHaveBeenLastCalledWith(expect.stringContaining('posted=1 created=1 failed=1'));
  });

  it.each([
    ['--before is missing', ['--product', 'product-a', '--channel', CHANNEL], ENV, /--before/],
    ['--channel is missing', ['--product', 'product-a', '--before', BEFORE], ENV, /--channel/],
    ['the product is not a slug', ['--product', 'Product A', '--channel', CHANNEL, '--before', BEFORE], ENV, /slug/],
    ['--before is not a date', ['--product', 'product-a', '--channel', CHANNEL, '--before', 'yesterday'], ENV, /--before/],
    ['a flag is unknown', [...baseArgs, '--channel-name', 'x'], ENV, /unknown flag/],
    ['there is no token and no --input', baseArgs, ENV, /SLACK_BOT_TOKEN/],
    ['ingest credentials are missing outside dry-run', baseArgs, { SLACK_BOT_TOKEN: TOKEN }, /QA_INGEST_URL/],
  ])('exits 1 when %s', async (_name, argv, env, message) => {
    const fetch = vi.fn();
    const log = makeLog();
    expect(await main(argv, env, { fetch, sleep: noSleep, log })).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(message));
    expect(fetch).not.toHaveBeenCalled();
  });
});
