import { createServer } from 'node:http';
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { ErrorCode, WebClient } from '@slack/web-api';
import { NOTEBOOK_DM_CLIENT_OPTIONS } from '../handlers/notebookNotification';

let requests = 0;
const server = createServer((request, response) => {
  requests += 1;
  if (request.url?.startsWith('/limited/')) {
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
    response.end(JSON.stringify({ ok: false, error: 'ratelimited' }));
  }
  // /slow intentionally leaves the actual HTTP response pending until Axios aborts it.
});
let baseUrl = '';
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local SDK fixture address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  requests = 0;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close(error => {
      if (error) reject(error);
      else resolve();
    })
  );
});

it('real Slack SDK rejects Retry-After 30 immediately instead of sleeping or retrying', async () => {
  const client = new WebClient('local-sdk-fixture', {
    ...NOTEBOOK_DM_CLIENT_OPTIONS,
    slackApiUrl: `${baseUrl}/limited/`,
  });
  const started = performance.now();
  await expect(client.conversations.open({ users: 'U1' })).rejects.toMatchObject({ code: ErrorCode.RateLimitedError });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(requests).toBe(1);
});

it('real Slack SDK HTTP transport aborts a stalled request at its finite timeout', async () => {
  const client = new WebClient('local-sdk-fixture', {
    ...NOTEBOOK_DM_CLIENT_OPTIONS,
    timeout: 40,
    slackApiUrl: `${baseUrl}/slow/`,
  });
  const started = performance.now();
  await expect(client.conversations.open({ users: 'U1' })).rejects.toMatchObject({ code: ErrorCode.RequestError });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(requests).toBe(1);
});
