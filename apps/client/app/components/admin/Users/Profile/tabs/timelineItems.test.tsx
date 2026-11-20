import { describe, expect, it, vi } from 'vitest';
import type { UserTimelineApiRequestEntry } from '@bike4mind/common';
import { timelineItems } from './timelineItems';

const request = (id: string, seconds: number, keyId = 'key-a'): UserTimelineApiRequestEntry => ({
  id,
  type: 'api_request',
  at: new Date(Date.UTC(2026, 10, 1, 12, 0, seconds)),
  summary: 'GET /api/v1/me - 200',
  request: { keyId, method: 'GET', endpoint: '/api/v1/me', statusCode: 200, responseTimeMs: 10, ip: '203.0.113.1' },
});

describe('timeline API grouping', () => {
  it('groups adjacent matching requests in a minute and keeps the newest timestamp and details link', () => {
    const onOpenApiRequests = vi.fn();
    const items = timelineItems([request('a', 50), request('b', 30), request('c', 0)], {
      onOpenAudit: vi.fn(),
      onOpenApiRequests,
    });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('api_request-a');
    expect(items[0].summary).toBe('GET /api/v1/me - 200 (3 calls in loaded activity)');
    items[0].onOpen?.();
    expect(onOpenApiRequests).toHaveBeenCalledOnce();
  });

  it('keeps different keys, outcomes and older calls separate', () => {
    const failed = request('b', 30);
    failed.request.statusCode = 403;
    const items = timelineItems([request('a', 50), failed, request('c', 20, 'other-key'), request('d', -20)], {
      onOpenAudit: vi.fn(),
    });
    expect(items).toHaveLength(4);
  });

  it('does not group across another timeline source', () => {
    const items = timelineItems(
      [
        request('a', 50),
        { type: 'signup', id: 'signup', at: request('b', 40).at, summary: 'Signed up' },
        request('c', 30),
      ],
      { onOpenAudit: vi.fn() }
    );
    expect(items).toHaveLength(3);
  });
});
