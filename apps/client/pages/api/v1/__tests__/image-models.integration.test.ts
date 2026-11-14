// @vitest-environment node
vi.mock('@bike4mind/server-utils/billing/assertMediaModelAdmission', () => ({
  filterAdmittedMediaModels: vi.fn(async (_user: unknown, models: unknown[]) => models),
}));

/**
 * Integration test for GET /api/v1/image-models through the real next-connect chain
 * (nextRouteForContract -> apiKeyAuth -> scope check -> validation -> handler). The model list, the listing domain
 * and the repository are mocked: their behaviour is covered in services and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { fire, h, resetHarness, validateWithScopes } from '@server/generations/__test__/routeHarness';

vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig =>
  (await import('@server/generations/__test__/routeHarness')).apiKeyRateLimitCheckMock(orig)
);
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', async () =>
  (await import('@server/generations/__test__/routeHarness')).rateLimitMiddlewareMock()
);
vi.mock('@bike4mind/server-utils/utils/userRateTier', async () =>
  (await import('@server/generations/__test__/routeHarness')).userRateTierMock()
);
vi.mock('@bike4mind/server-utils/utils/orgAccess', async orig =>
  (await import('@server/generations/__test__/routeHarness')).orgAccessMock(orig)
);
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async orig =>
  (await import('@server/generations/__test__/routeHarness')).servicesMock(orig)
);
vi.mock('@bike4mind/database', async orig =>
  (await import('@server/generations/__test__/routeHarness')).databaseMock(orig)
);
vi.mock('@bike4mind/server-utils/generationJobs/wiring', async () =>
  (await import('@server/generations/__test__/routeHarness')).wiringMock()
);
vi.mock('@bike4mind/server-utils/generations/signOutputUrl', async () =>
  (await import('@server/generations/__test__/routeHarness')).signOutputUrlMock()
);
vi.mock('@bike4mind/server-utils/imageGenerations/listUsableImageModels', async orig =>
  (await import('@server/generations/__test__/routeHarness')).listUsableImageModelsMock(orig)
);
vi.mock('@server/utils/callerModelList', () => ({
  getCallerModelList: (...a: unknown[]) => h.getCallerModelList(...a),
}));
vi.mock('@server/auth/auth', async orig => (await import('@server/generations/__test__/routeHarness')).authMock(orig));

import { filterAdmittedMediaModels } from '@bike4mind/server-utils/billing/assertMediaModelAdmission';
import handler from '../image-models';

describe('GET /api/v1/image-models', () => {
  beforeEach(resetHarness);

  it('lists the enabled image models of the caller and returns what is usable', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.getCallerModelList.mockResolvedValue({
      models: [
        { id: 'flux-3-image', name: 'Flux 3', type: 'image', disabled: false },
        { id: 'gpt-image-1.5', name: 'GPT Image', type: 'image', disabled: true },
        { id: 'gpt-4o', name: 'GPT-4o', type: 'text', disabled: false },
      ],
    });
    h.listUsableImageModels.mockResolvedValue([{ id: 'flux-3-image' }]);
    const { req, res } = fire({ url: '/api/v1/image-models' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ models: [{ id: 'flux-3-image' }] });
    expect(filterAdmittedMediaModels).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }), [
      { id: 'flux-3-image' },
    ]);
    expect(h.listUsableImageModels).toHaveBeenCalledWith(
      'user-1',
      [expect.objectContaining({ id: 'flux-3-image', name: 'Flux 3' })],
      expect.anything()
    );
  });

  it('403s a key without ai:generate', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = fire({ url: '/api/v1/image-models' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
  });
});
