// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real emitter, so what reaches the ingest endpoint is checked, the metadata allowlist included.
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: {
    B4M_ANALYTICS_ENABLED: 'true',
    OVERWATCH_INGEST_URL: 'https://ingest.example.com/api/overwatch/v1/events',
    OVERWATCH_INGEST_KEY: 'test-host-ingest-key',
    OVERWATCH_PRODUCT_INGEST_KEYS: '',
    OVERWATCH_PSEUDONYM_SALT: 'test-pseudonym-salt',
    STAGE: 'test',
  },
}));

import { pseudonymize } from '@bike4mind/server-utils/analytics/pseudonymize';
import { __resetQuestFeatureThrottle, forwardQuestFeature } from './questFeature';
import { VISIT_COOKIE, mintVisitId } from './visitSession';

const mockFetch = vi.fn();

beforeEach(() => {
  __resetQuestFeatureThrottle();
  mockFetch.mockReset().mockResolvedValue({ status: 202, type: 'basic' });
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('forwardQuestFeature through the emitter', () => {
  it('posts quest_feature_used with its feature and marks to the host product', async () => {
    const visitId = mintVisitId();
    const req = {
      user: { id: 'user-1', isAdmin: false, isSynthetic: true, tags: ['rounds'] },
      headers: { cookie: `${VISIT_COOKIE}=${visitId}` },
    } as unknown as Parameters<typeof forwardQuestFeature>[0];

    await forwardQuestFeature(req, 'AI Image Generated');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://ingest.example.com/api/overwatch/v1/events');
    expect(init.headers['x-api-key']).toBe('test-host-ingest-key');
    const { event } = JSON.parse(init.body);
    expect(event).toMatchObject({
      productId: 'bike4mind',
      event: 'quest_feature_used',
      userId: pseudonymize('user-1', 'test-pseudonym-salt'),
      sessionId: visitId,
    });
    expect(event.metadata).toEqual({ feature: 'ai_image_generated', lane: 'synthetic', internal: true });
  });
});
