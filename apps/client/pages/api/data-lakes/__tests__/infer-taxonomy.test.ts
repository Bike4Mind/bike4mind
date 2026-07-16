import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';

// isDevelopment is toggled per test via this hoisted flag (it reads SST Resource in prod code).
const { devFlag } = vi.hoisted(() => ({ devFlag: { value: false } }));

// Stub the middleware/service/db/openai imports so the route module loads without a real
// stack. hasDeveloperUserTag (from @bike4mind/common) is intentionally NOT mocked - it is
// the logic under test.
vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, () => unknown> = {};
  chain.use = () => chain;
  chain.post = () => chain;
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/config', () => ({ isDevelopment: () => devFlag.value }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveApiKey: vi.fn() } }));
vi.mock('@bike4mind/database', () => ({ apiKeyRepository: {}, adminSettingsRepository: {} }));
vi.mock('openai', () => ({ default: class {} }));

import { resolveTaxonomyDailyLimit, TAXONOMY_INFERENCE_DAILY_CAP } from '../infer-taxonomy';

const req = (user: unknown): Request => ({ user }) as unknown as Request;

describe('resolveTaxonomyDailyLimit', () => {
  beforeEach(() => {
    devFlag.value = false;
  });

  it('is uncapped on a dev server regardless of the user', () => {
    devFlag.value = true;
    expect(resolveTaxonomyDailyLimit(req({ id: 'u', isAdmin: false, tags: [] }))).toBe(Infinity);
  });

  it('is uncapped for admins', () => {
    expect(resolveTaxonomyDailyLimit(req({ id: 'u', isAdmin: true, tags: [] }))).toBe(Infinity);
  });

  it('is uncapped for developer-tagged users', () => {
    expect(resolveTaxonomyDailyLimit(req({ id: 'u', isAdmin: false, tags: ['developer'] }))).toBe(Infinity);
  });

  it('caps other permitted (e.g. opti-tagged) users at the daily cap', () => {
    expect(resolveTaxonomyDailyLimit(req({ id: 'u', isAdmin: false, tags: ['opti'] }))).toBe(
      TAXONOMY_INFERENCE_DAILY_CAP
    );
  });
});
