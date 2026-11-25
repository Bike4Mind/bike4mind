import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

describe('SlackClient.downloadFile', () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
  const seenAuth: Array<string | undefined> = [];
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenAuth.push(req.headers.authorization);
      if (req.url === '/file') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(bytes);
      } else if (req.url === '/same-host-redirect') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/file` });
        res.end();
      } else if (req.url === '/other-host-redirect') {
        res.writeHead(302, { Location: `http://localhost:${port}/file` });
        res.end();
      } else {
        res.writeHead(404);
        res.end('nope');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  const download = (pathname: string) =>
    new SlackClient('xoxb-test-token', logger).downloadFile(`http://127.0.0.1:${port}${pathname}`, 'f.bin');

  it('returns the exact bytes and sends the bot token as a bearer credential', async () => {
    seenAuth.length = 0;
    const buffer = await download('/file');
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.equals(bytes)).toBe(true);
    expect(seenAuth).toEqual(['Bearer xoxb-test-token']);
  });

  it('rejects when Slack answers with an error status', async () => {
    await expect(download('/missing')).rejects.toThrow();
  });

  it('keeps the credential across a redirect within the same host', async () => {
    seenAuth.length = 0;
    const buffer = await download('/same-host-redirect');
    expect(buffer.equals(bytes)).toBe(true);
    expect(seenAuth).toEqual(['Bearer xoxb-test-token', 'Bearer xoxb-test-token']);
  });

  it('drops the credential when a redirect leaves the host', async () => {
    seenAuth.length = 0;
    const buffer = await download('/other-host-redirect');
    expect(buffer.equals(bytes)).toBe(true);
    expect(seenAuth).toEqual(['Bearer xoxb-test-token', undefined]);
  });
});
