// @vitest-environment node
/**
 * Integration test for POST /api/v1/text-refinements through the real next-connect chain
 * (nextRouteForContract -> apiKeyAuth -> scope check -> validation -> handler). The shared refine
 * helper is mocked: its cache + model call are covered by the legacy route's test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { fire, resetHarness, validateWithScopes } from '@server/generations/__test__/routeHarness';

const { mockRefine } = vi.hoisted(() => ({ mockRefine: vi.fn() }));

vi.mock('@server/ai/refineTextRequest', () => {
  class RefineProviderUnavailableError extends Error {}
  return { refineTextRequest: mockRefine, RefineProviderUnavailableError };
});
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig =>
  (await import('@server/generations/__test__/routeHarness')).apiKeyRateLimitCheckMock(orig)
);
vi.mock('@server/middlewares/rateLimit', async () =>
  (await import('@server/generations/__test__/routeHarness')).rateLimitMiddlewareMock()
);
vi.mock('@server/utils/userRateTier', async () =>
  (await import('@server/generations/__test__/routeHarness')).userRateTierMock()
);
vi.mock('@server/utils/orgAccess', async orig =>
  (await import('@server/generations/__test__/routeHarness')).orgAccessMock(orig)
);
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async orig =>
  (await import('@server/generations/__test__/routeHarness')).servicesMock(orig)
);
vi.mock('@bike4mind/database', async orig =>
  (await import('@server/generations/__test__/routeHarness')).databaseMock(orig)
);
vi.mock('@server/auth/auth', async orig => (await import('@server/generations/__test__/routeHarness')).authMock(orig));

import handler from '../text-refinements';
import { RefineProviderUnavailableError } from '@server/ai/refineTextRequest';

const post = (body: Record<string, unknown>) => fire({ method: 'POST', url: '/api/v1/text-refinements', body });

describe('POST /api/v1/text-refinements', () => {
  beforeEach(() => {
    resetHarness();
    mockRefine.mockReset();
  });

  it('returns the refined text for a key with ai:generate', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    mockRefine.mockResolvedValue('A refined dog on a sunlit beach');
    const { req, res } = post({ text: 'a dog on a beach', context: 'image prompt' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ text: 'A refined dog on a sunlit beach' });
    expect(mockRefine).toHaveBeenCalledWith(
      { text: 'a dog on a beach', context: 'image prompt' },
      expect.objectContaining({ logger: expect.anything() })
    );
  });

  it('403s a key without ai:generate', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = post({ text: 'hello' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(mockRefine).not.toHaveBeenCalled();
  });

  it.each([{}, { text: '' }])('422s an invalid body %j', async body => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post(body);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(mockRefine).not.toHaveBeenCalled();
  });

  it('503s with provider_not_configured when no operations model exists', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    mockRefine.mockRejectedValue(new RefineProviderUnavailableError());
    const { req, res } = post({ text: 'hello' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'provider_not_configured' });
  });

  it('502s instead of answering 200 with no text', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    mockRefine.mockResolvedValue(undefined);
    const { req, res } = post({ text: 'hello' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(502);
  });

  it('502s when the model call throws', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    mockRefine.mockRejectedValue(new Error('boom'));
    const { req, res } = post({ text: 'hello' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(502);
  });
});
