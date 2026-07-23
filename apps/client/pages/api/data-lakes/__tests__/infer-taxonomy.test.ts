import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Request, Response } from 'express';

type RouteHandler = (req: Request, res: Response) => Promise<unknown>;

// isDevelopment is toggled per test via devFlag (it reads SST Resource in prod code).
// captured.handler holds the route's POST callback so a test can invoke the handler body
// directly - that is where the removed admin/opti/developer tag gate used to live.
const { devFlag, captured } = vi.hoisted(() => ({
  devFlag: { value: false },
  captured: {} as { handler?: RouteHandler },
}));

// Stub the middleware/service/db/openai imports so the route module loads without a real
// stack. hasDeveloperUserTag (from @bike4mind/common) is intentionally NOT mocked - it is
// the logic under test. baseApi().post(fn) captures fn so the admit path can be exercised
// directly; requireFeatureEnabled and rateLimit stay pass-through here because the gate the
// tests care about (the removed tag gate) lived in the handler body, not those middlewares.
vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, (fn?: RouteHandler) => unknown> = {};
  chain.use = () => chain;
  chain.post = (fn?: RouteHandler) => {
    captured.handler = fn;
    return chain;
  };
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

import { apiKeyService } from '@bike4mind/services';
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

// #532 removed the admin/opti/developer tag gate: access is now the EnableDataLakes flag
// alone (plus the daily rate cap). A feature-enabled, untagged, non-admin user used to be
// 403'd here mid create-wizard; this locks in that they now reach the handler instead.
describe('POST handler (gate-removal admit path)', () => {
  beforeEach(() => {
    devFlag.value = false;
    (apiKeyService.getEffectiveApiKey as Mock).mockReset();
  });

  it('admits a feature-enabled, untagged, non-admin user and runs the handler', async () => {
    // No OpenAI key -> the handler degrades to an empty taxonomy (non-blocking) with 200.
    // Reaching this path at all proves the user was admitted rather than gate-rejected.
    (apiKeyService.getEffectiveApiKey as Mock).mockResolvedValue(null);
    const json = vi.fn();
    const res = { json } as unknown as Response;
    const request = {
      user: { id: 'u', isAdmin: false, tags: [] },
      body: { folderTree: [{ relativePath: 'docs/a.txt', fileName: 'a.txt', fileSize: 10 }] },
    } as unknown as Request;

    await captured.handler!(request, res);

    expect(apiKeyService.getEffectiveApiKey).toHaveBeenCalledWith(
      'u',
      expect.objectContaining({ nullIfMissing: true }),
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedPrefix: '', categories: [], fileAssignments: [] })
    );
  });
});
