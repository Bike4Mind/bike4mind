// @vitest-environment node
/**
 * Integration test for GET /api/v1/video-models through the real next-connect chain
 * (nextRouteForContract -> apiKeyAuth -> scope check -> validation -> handler). The domain (createVideoJob)
 * and the repository are mocked: their behaviour is covered in services and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { fire, h, resetHarness, validateWithScopes } from '@server/videoGenerations/__test__/routeHarness';

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).apiKeyRateLimitCheckMock(orig)
);
vi.mock('@server/middlewares/rateLimit', async () =>
  (await import('@server/videoGenerations/__test__/routeHarness')).rateLimitMiddlewareMock()
);
vi.mock('@server/utils/userRateTier', async () =>
  (await import('@server/videoGenerations/__test__/routeHarness')).userRateTierMock()
);
vi.mock('@server/utils/orgAccess', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).orgAccessMock(orig)
);
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).servicesMock(orig)
);
vi.mock('@bike4mind/services/videoJobs', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).videoJobsServiceMock(orig)
);
vi.mock('@bike4mind/database', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).databaseMock(orig)
);
vi.mock('@server/generationJobs/wiring', async () =>
  (await import('@server/videoGenerations/__test__/routeHarness')).wiringMock()
);
vi.mock('@server/videoGenerations/signOutputUrl', async () =>
  (await import('@server/videoGenerations/__test__/routeHarness')).signOutputUrlMock()
);
vi.mock('@server/videoGenerations/listUsableVideoModels', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).listUsableVideoModelsMock(orig)
);
vi.mock('@server/auth/auth', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).authMock(orig)
);

import handler from '../video-models';

describe('GET /api/v1/video-models', () => {
  beforeEach(resetHarness);

  it('returns the usable models for the caller', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.listUsableVideoModels.mockResolvedValue([{ id: 'gemini-omni-1.1-flash' }]);
    const { req, res } = fire({ url: '/api/v1/video-models' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ models: [{ id: 'gemini-omni-1.1-flash' }] });
    expect(h.listUsableVideoModels).toHaveBeenCalledWith('user-1', expect.anything());
  });

  it('403s a key without ai:generate', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = fire({ url: '/api/v1/video-models' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
  });
});
