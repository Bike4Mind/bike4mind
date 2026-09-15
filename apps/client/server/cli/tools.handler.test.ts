import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

// Keep @bike4mind/common real so the wrapper's resolveRequestId runs for real.
// Mock the inner handler so we can assert exactly what ID the wrapper threads
// in, and exercise the outer fallback in isolation.

vi.mock('@bike4mind/utils', () => ({ registerLambdaErrorHandlers: vi.fn() }));
vi.mock('./tools', () => ({ handleToolRequest: vi.fn() }));

import { handler } from './tools.handler';
import { handleToolRequest } from './tools';
import { REQUEST_ID_HEADER } from '@bike4mind/common';

function makeEvent(headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  // any: minimal stand-in - only event.headers is read by the wrapper
  return { headers, rawPath: '/api/ai/v1/tools', requestContext: { http: { method: 'POST' } } } as any;
}

/** The request ID threaded into handleToolRequest on its most recent call. */
function threadedId(): string {
  return vi.mocked(handleToolRequest).mock.calls.at(-1)?.[1] as string;
}

describe('tools Lambda wrapper — request ID threading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('resolves a caller X-Request-ID once and threads it into the inner handler', async () => {
    vi.mocked(handleToolRequest).mockResolvedValue({ statusCode: 200, body: '{}' });

    await handler(makeEvent({ 'x-request-id': 'caller-1' }));

    expect(handleToolRequest).toHaveBeenCalledTimes(1);
    expect(threadedId()).toBe('caller-1');
  });

  it('accepts the legacy Request-ID header', async () => {
    vi.mocked(handleToolRequest).mockResolvedValue({ statusCode: 200, body: '{}' });

    await handler(makeEvent({ 'request-id': 'legacy-1' }));

    expect(threadedId()).toBe('legacy-1');
  });

  it('generates a request ID when the caller supplies none', async () => {
    vi.mocked(handleToolRequest).mockResolvedValue({ statusCode: 200, body: '{}' });

    await handler(makeEvent());

    expect(threadedId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses the SAME id in the outer fallback as it threaded inward (no divergent UUIDs)', async () => {
    vi.mocked(handleToolRequest).mockRejectedValue(new Error('inner blew up'));

    const result = (await handler(makeEvent())) as APIGatewayProxyStructuredResultV2;
    const body = JSON.parse(result.body as string);

    expect(result.statusCode).toBe(500);
    // The pre-resolved id threaded inward must equal the one in the fallback
    // header and body - the whole point of resolving once in the wrapper.
    expect(result.headers?.[REQUEST_ID_HEADER]).toBe(threadedId());
    expect(body.request_id).toBe(threadedId());
  });
});
