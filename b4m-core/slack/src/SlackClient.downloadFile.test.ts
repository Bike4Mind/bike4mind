import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackClient } from './SlackClient';

vi.mock('./di/registry', () => ({
  getSlackDeps: () => ({ integrationCircuitBreaker: { isAvailable: vi.fn() } }),
  getSlackDb: () => ({}),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return { token: 'xoxb-test-token', chat: { postMessage: vi.fn() }, on: vi.fn() };
  }),
  WebClientEvent: { RATE_LIMITED: 'rate_limited' },
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
const FILE_URL = 'https://files.slack.com/files-pri/T1-F1/download/f.bin';

type Hop = { url: string; auth: string | undefined };

function stubFetch(routes: Record<string, Response | (() => Response)>): Hop[] {
  const hops: Hop[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      hops.push({ url, auth: headers.Authorization });
      const route = routes[url];
      if (!route) return new Response('nope', { status: 404 });
      return typeof route === 'function' ? route() : route;
    })
  );
  return hops;
}

const redirect = (location: string) => () => new Response(null, { status: 302, headers: { Location: location } });
const ok = () => new Response(bytes, { status: 200 });

describe('SlackClient.downloadFile', () => {
  const download = (url: string) => new SlackClient('xoxb-test-token', logger).downloadFile(url, 'f.bin');

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('returns the exact bytes and sends the bot token to the Slack file host', async () => {
    const hops = stubFetch({ [FILE_URL]: ok });
    const buffer = await download(FILE_URL);
    expect(buffer.equals(bytes)).toBe(true);
    expect(hops).toEqual([{ url: FILE_URL, auth: 'Bearer xoxb-test-token' }]);
  });

  it('rejects when Slack answers with an error status', async () => {
    stubFetch({});
    await expect(download(FILE_URL)).rejects.toThrow();
  });

  it.each([
    'https://attacker.example/f.bin',
    'http://files.slack.com/files-pri/T1-F1/f.bin',
    'https://files.slack.com.attacker.example/f.bin',
    'https://files.slack.com:8443/f.bin',
    'https://user@files.slack.com/f.bin',
    'http://127.0.0.1/internal',
  ])('never contacts a URL outside the Slack file hosts: %s', async url => {
    const hops = stubFetch({ [url]: ok });
    await expect(download(url)).rejects.toThrow();
    expect(hops).toEqual([]);
  });

  it('keeps the credential across a redirect within the Slack file hosts', async () => {
    const next = 'https://files.slack.com/files-pri/T1-F1/f.bin?origin=1';
    const hops = stubFetch({ [FILE_URL]: redirect(next), [next]: ok });
    const buffer = await download(FILE_URL);
    expect(buffer.equals(bytes)).toBe(true);
    expect(hops.map(h => h.auth)).toEqual(['Bearer xoxb-test-token', 'Bearer xoxb-test-token']);
  });

  it('drops the credential when a redirect leaves the Slack file hosts', async () => {
    const next = 'https://cdn.example/f.bin';
    const hops = stubFetch({ [FILE_URL]: redirect(next), [next]: ok });
    await download(FILE_URL);
    expect(hops).toEqual([
      { url: FILE_URL, auth: 'Bearer xoxb-test-token' },
      { url: next, auth: undefined },
    ]);
  });

  it('refuses a redirect off https', async () => {
    const hops = stubFetch({ [FILE_URL]: redirect('http://cdn.example/f.bin') });
    await expect(download(FILE_URL)).rejects.toThrow();
    expect(hops).toHaveLength(1);
  });
});
