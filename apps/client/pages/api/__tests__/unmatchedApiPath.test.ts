import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { createMocks } from 'node-mocks-http';
import handler from '../[...unmatchedApiPath]';

describe('/api/[...unmatchedApiPath]', () => {
  it.each(['GET', 'POST', 'DELETE'])('answers %s with a JSON 404 in the shared error envelope', async method => {
    const { req, res } = createMocks(
      {
        method: method as 'GET',
        url: '/api/does-not-exist/at/all',
        query: { unmatchedApiPath: ['does-not-exist', 'at', 'all'] },
        headers: { 'x-request-id': 'req-404-test' },
      },
      { eventEmitter: EventEmitter }
    );

    // node-mocks-http doubles stand in for the express req/res next-connect is typed against.
    await handler(req as any, res as any);

    expect(res.statusCode).toBe(404);
    expect(res._isJSON()).toBe(true);
    expect(res._getJSONData()).toMatchObject({ error: 'No API route matches this path', request_id: 'req-404-test' });
    expect(res.getHeader('X-Request-ID')).toBe('req-404-test');
  });
});
