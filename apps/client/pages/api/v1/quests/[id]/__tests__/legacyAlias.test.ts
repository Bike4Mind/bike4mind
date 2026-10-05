import { describe, it, expect, vi } from 'vitest';

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => ({ get: () => ({ handler: 'quest-poll' }) }),
}));
vi.mock('@bike4mind/database', () => ({ questRepository: {}, sessionRepository: {} }));

describe('GET /api/quests/[id] legacy alias', () => {
  it('serves the same handler as GET /api/v1/quests/{id}', async () => {
    const legacy = await import('@pages/api/quests/[id]/index');
    const v1 = await import('@pages/api/v1/quests/[id]/index');
    expect(legacy.default).toBe(v1.default);
  });
});
