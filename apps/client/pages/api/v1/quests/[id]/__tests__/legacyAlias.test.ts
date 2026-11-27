import { describe, it, expect, vi } from 'vitest';

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => ({ get: () => ({ handler: 'quest-poll' }) }),
}));
vi.mock('@bike4mind/database', () => ({ questRepository: {}, sessionRepository: {} }));

import legacyHandler from '@pages/api/quests/[id]/index';
import v1Handler from '@pages/api/v1/quests/[id]/index';

describe('GET /api/quests/[id] legacy alias', () => {
  it('serves the same handler as GET /api/v1/quests/{id}', () => {
    expect(legacyHandler).toBe(v1Handler);
  });
});
