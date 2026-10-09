// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import handler from '../generate-video';

describe('/api/ai/generate-video (removed)', () => {
  it.each(['POST', 'GET'] as const)('answers %s with 410 and points at the replacement', async method => {
    const { req, res } = createMocks({ method, url: '/api/ai/generate-video' }, { eventEmitter: EventEmitter });
    // any: node-mocks-http mocks aren't structurally the Next request/response types.
    await handler(req as any, res as any);
    expect(res._getStatusCode()).toBe(410);
    expect(res._getJSONData()).toEqual({
      error: 'This endpoint was removed. Use POST /api/v1/video-generations.',
      replacement: 'POST /api/v1/video-generations',
    });
  });
});
