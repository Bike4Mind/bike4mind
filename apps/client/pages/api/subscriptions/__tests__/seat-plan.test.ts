// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const state = vi.hoisted(() => ({ options: undefined as unknown, handler: undefined as Handler | undefined }));
const getRequestActiveSubscriptions = vi.hoisted(() => vi.fn());
const resolveSeatPlan = vi.hoisted(() => vi.fn());

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    state.options = options;
    return {
      get: (handler: Handler) => {
        state.handler = handler;
        return handler;
      },
    };
  },
}));
vi.mock('@bike4mind/server-utils/entitlements/activeSubscriptions', () => ({ getRequestActiveSubscriptions }));
vi.mock('@server/subscriptions/seatPlan', () => ({ resolveSeatPlan }));

await import('../seat-plan');

const call = async () => {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user: { id: 'user-1' } });
  await state.handler!(req, res);
  return { req, res };
};

describe('GET /api/subscriptions/seat-plan', () => {
  beforeEach(() => {
    getRequestActiveSubscriptions.mockReset();
    resolveSeatPlan.mockReset();
  });

  it('refuses API keys', () => {
    expect(state.options).toEqual({ auth: 'jwtOnly' });
  });

  it("resolves the seat plan from the caller's active subscriptions, uncached", async () => {
    const rows = [{ ownerType: 'Organization', ownerId: 'org-1', priceId: 'price_team' }];
    getRequestActiveSubscriptions.mockResolvedValue(rows);
    resolveSeatPlan.mockResolvedValue({ organizationId: 'org-1', organizationName: 'Acme', planName: 'Team' });

    const { req, res } = await call();

    expect(getRequestActiveSubscriptions).toHaveBeenCalledWith(req);
    expect(resolveSeatPlan).toHaveBeenCalledWith(rows);
    expect(res._getJSONData()).toEqual({
      seatPlan: { organizationId: 'org-1', organizationName: 'Acme', planName: 'Team' },
    });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('returns null when the caller holds no seat', async () => {
    getRequestActiveSubscriptions.mockResolvedValue([]);
    resolveSeatPlan.mockResolvedValue(null);

    const { res } = await call();

    expect(res._getJSONData()).toEqual({ seatPlan: null });
  });
});
