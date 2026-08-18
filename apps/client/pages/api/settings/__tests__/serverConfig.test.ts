// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// serverConfig.ts builds its API handler at module load, so stub the middleware and the
// heavy DB/service deps; computeToolAvailability is a 4-line delegation this test verifies.
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (fn: unknown) => fn }) }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/utils/config', () => ({ Config: {} }));
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: { name: 'apiKeys' },
  adminSettingsRepository: { name: 'adminSettings' },
}));

const resolveToolAvailability = vi.fn().mockResolvedValue({ weather_info: true });
vi.mock('@bike4mind/services', () => ({
  resolveToolAvailability: (...a: unknown[]) => resolveToolAvailability(...a),
  isLocalImageBackendAvailable: vi.fn(),
  isLocalEmbedderAvailable: vi.fn(),
}));

import { computeToolAvailability } from '../serverConfig';

describe('computeToolAvailability (thin wrapper over resolveToolAvailability)', () => {
  it('delegates to resolveToolAvailability with the apiKeys/adminSettings repos and returns its result', async () => {
    const result = await computeToolAvailability('user-1');

    expect(resolveToolAvailability).toHaveBeenCalledWith('user-1', {
      db: { apiKeys: { name: 'apiKeys' }, adminSettings: { name: 'adminSettings' } },
    });
    expect(result).toEqual({ weather_info: true });
  });

  it('passes userId through unchanged, including undefined for an anonymous request', async () => {
    await computeToolAvailability(undefined);
    expect(resolveToolAvailability).toHaveBeenCalledWith(undefined, expect.anything());
  });
});
