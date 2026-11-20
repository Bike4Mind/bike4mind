// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  signals: vi.fn(),
  state: vi.fn(),
  baseOptions: [] as unknown[],
}));

// Runs the adminApi permission guard for real; a thrown HTTP error becomes its status code.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseOptions.push(options);
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const guards: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: { method?: string }, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
        try {
          for (const guard of guards) guard(req, res, () => undefined);
          return await routes[req.method ?? 'GET']?.(req, res);
        } catch (error) {
          res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message });
        }
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (guards.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/security/incidentSignals', () => ({ getIncidentSignals: h.signals }));
vi.mock('@server/security/incidentState', () => ({ getIncidentState: h.state }));

import incidentSignals from '../incident-signals';
import incidentState from '../incident-state';

type Route = (req: unknown, res: unknown) => Promise<void>;

const call = async (route: unknown, user: Record<string, unknown>, query: Record<string, string> = {}) => {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user });
  await (route as Route)(req, res);
  return res;
};

const admin = { id: 'admin-1', isAdmin: true };
const member = { id: 'user-1', isAdmin: false };

beforeEach(() => {
  vi.clearAllMocks();
  h.signals.mockResolvedValue({ range: '24h', metrics: {}, waf: {}, alarms: {}, blockLists: {} });
  h.state.mockResolvedValue({ defenses: {}, queues: {}, payments: {} });
});

describe('admin security incident routes', () => {
  it('declares JWT-only auth so no API key can reach them', () => {
    expect(h.baseOptions).toHaveLength(2);
    for (const options of h.baseOptions) expect(options).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['GET'] });
  });

  it.each([
    ['incident-signals', incidentSignals, h.signals],
    ['incident-state', incidentState, h.state],
  ])('%s rejects a non-admin before reading anything', async (_name, route, read) => {
    const res = await call(route, member);
    expect(res._getStatusCode()).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it('serves incident signals for the requested range, defaulting to 24h, uncached', async () => {
    const res = await call(incidentSignals, admin, { range: '7d' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.signals).toHaveBeenCalledWith('7d');
    expect(res._getJSONData()).toEqual({ range: '24h', metrics: {}, waf: {}, alarms: {}, blockLists: {} });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');

    await call(incidentSignals, admin);
    expect(h.signals).toHaveBeenLastCalledWith('24h');
  });

  it('rejects a range outside 1h, 24h and 7d', async () => {
    const res = await call(incidentSignals, admin, { range: '30d' });
    expect(res._getStatusCode()).toBe(400);
    expect(h.signals).not.toHaveBeenCalled();
  });

  it('serves incident state, uncached', async () => {
    const res = await call(incidentState, admin);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ defenses: {}, queues: {}, payments: {} });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });
});
