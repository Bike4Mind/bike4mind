import { describe, expect, it, vi } from 'vitest';

// The legacy path must re-export the nextRouteForContract handler and keep its inline config.
const v1Handler = vi.hoisted(() => ({ handler: 'session-clone' }));
vi.mock('@pages/api/v1/sessions/[id]/clone', () => ({ default: v1Handler }));

describe('POST /api/sessions/[id]/clone legacy alias', () => {
  it('serves the v1 handler and keeps externalResolver', async () => {
    const legacy = await import('@pages/api/sessions/[id]/clone');
    expect(legacy.default).toBe(v1Handler);
    expect(legacy.config).toEqual({ api: { externalResolver: true } });
  });
});
