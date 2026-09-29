import { describe, it, expect, vi } from 'vitest';
// The legacy path must re-export the nextRouteForContract handler and keep its inline config.
const v1Handler = vi.hoisted(() => ({ handler: 'session-create' }));
vi.mock('@pages/api/v1/sessions/index', () => ({ default: v1Handler }));

describe('POST /api/sessions/create legacy alias', () => {
  it('serves the same handler as POST /api/v1/sessions and keeps externalResolver', async () => {
    const legacy = await import('@pages/api/sessions/create');
    expect(legacy.default).toBe(v1Handler);
    expect(legacy.config).toEqual({ api: { externalResolver: true } });
  });
});
