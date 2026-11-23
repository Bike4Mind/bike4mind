import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { fetchAnthropicSpend, type ProviderSpendDiagnostic } from './providerSpendFetchers';

async function withLoopbackServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (fetchFn: typeof fetch) => Promise<void>
) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/organizations/cost_report') {
      throw new Error('Unexpected provider URL');
    }
    url.protocol = 'http:';
    url.hostname = '127.0.0.1';
    url.port = String(address.port);
    return fetch(url, init);
  };
  try {
    await run(fetchFn);
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

describe('provider spend over HTTP', () => {
  it('honors Retry-After with native fetch and reads the complete successful body', async () => {
    const requests: { at: number; url: string; key: string | undefined }[] = [];
    const diagnostics: ProviderSpendDiagnostic[] = [];
    await withLoopbackServer(
      (request, response) => {
        requests.push({ at: Date.now(), url: request.url!, key: request.headers['x-api-key'] as string });
        response.setHeader('content-type', 'application/json');
        if (requests.length === 1) {
          response.writeHead(429, { 'Retry-After': '1', 'Request-Id': 'req-local-retry' });
          response.end(JSON.stringify({ error: { type: 'rate_limit_error' } }));
          return;
        }
        response.writeHead(200);
        response.write('{"data":[{"results":');
        setTimeout(() => {
          response.end(
            '[{"amount":"125.00","description":"input"},{"amount":"75.00","description":"output"}]}],"has_more":false}'
          );
        }, 10);
      },
      async fetchFn => {
        const result = await fetchAnthropicSpend('synthetic-admin-key', '2026-07', fetchFn, {
          deadlineMs: Date.now() + 5_000,
          onDiagnostic: diagnostic => diagnostics.push(diagnostic),
        });
        expect(result).toEqual({ providerUsd: 2, orgUsd: 2, breakdown: { input: 1.25, output: 0.75 } });
      }
    );
    expect(requests).toHaveLength(2);
    expect(requests[1].at - requests[0].at).toBeGreaterThanOrEqual(1_000);
    expect(requests[1].url).toBe(requests[0].url);
    for (const request of requests) {
      const url = new URL(request.url, 'http://127.0.0.1');
      expect(url.searchParams.getAll('group_by[]')).toEqual(['description']);
      expect(url.searchParams.get('starting_at')).toBe('2026-07-01T00:00:00.000Z');
      expect(url.searchParams.get('ending_at')).toBe('2026-08-01T00:00:01.000Z');
      expect(request.key).toBe('synthetic-admin-key');
    }
    expect(diagnostics).toEqual([
      expect.objectContaining({
        provider: 'Anthropic',
        event: 'retry',
        status: 429,
        requestId: 'req-local-retry',
        rateLimitHeaders: { 'retry-after': '1' },
        delayMs: 1_000,
      }),
    ]);
  });

  it('aborts a successful response whose body stalls beyond the shared deadline', async () => {
    let requests = 0;
    let responseClosed: Promise<unknown> | undefined;
    await withLoopbackServer(
      (_request, response) => {
        requests++;
        responseClosed = once(response, 'close');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"data":[');
      },
      async fetchFn => {
        const startedAt = Date.now();
        await expect(
          fetchAnthropicSpend('synthetic-admin-key', '2026-07', fetchFn, {
            deadlineMs: startedAt + 300,
          })
        ).rejects.toThrow(/Anthropic API 200: deadline/);
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            responseClosed,
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error('Response was not aborted')), 1_000);
            }),
          ]);
        } finally {
          clearTimeout(timeoutId);
        }
        expect(requests).toBe(1);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
      }
    );
  });
});
