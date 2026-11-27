// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The two baseApi options the hosted MCP endpoint relies on: `authChallenge` puts WWW-Authenticate on a 401, and
 * `skipApiKeyRateLimit` reaches the API-key limiter. next-connect is stubbed to a recorder of use() registrations.
 */

const h = vi.hoisted(() => ({
  useCalls: [] as unknown[],
  apiKeyRateLimitMock: vi.fn((_options: unknown) => () => {}),
}));

vi.mock('next-connect', () => ({
  default: () => {
    const router: Record<string, unknown> = {
      use: (...mw: unknown[]) => {
        h.useCalls.push(...mw);
        return router;
      },
      all: () => router,
    };
    return router;
  },
}));

vi.mock('@server/middlewares/apiKeyRateLimit', () => ({ apiKeyRateLimit: h.apiKeyRateLimitMock }));
vi.mock('@server/auth/auth', () => ({ authMiddleware: [], auth: () => {} }));
vi.mock('@bike4mind/server-utils/services/gears/toolGearObserver', () => ({ registerToolGearObserver: () => {} }));
vi.mock('@bike4mind/server-utils/organizations/registerOrgAlertObserver', () => ({
  registerOrgAlertObserver: () => {},
}));
vi.mock('@bike4mind/server-utils/lib/settings/registerContributedSettings', () => ({}));
vi.mock('@server/middlewares/logging', () => ({ logging: () => {} }));
vi.mock('@server/middlewares/errorHandler', () => ({ default: () => {} }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({ apiKeyAuth: () => () => {} }));
vi.mock('@server/middlewares/apiKeyAnomalyDetection', () => ({ apiKeyAnomalyDetection: () => () => {} }));
vi.mock('@server/analytics/analyticsMiddleware', () => ({ analyticsMiddleware: () => () => {} }));
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: () => () => {} }));
vi.mock('@bike4mind/database', () => ({ connectDB: async () => {} }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://test/%STAGE%', STAGE: 'test' },
  isDevelopment: () => true,
}));

import { baseApi } from './baseApi';

type FakeRes = {
  statusCode: number;
  headers: Record<string, string>;
  writeHead: (status?: unknown) => FakeRes;
  hasHeader: (name: string) => boolean;
  setHeader: (name: string, value: string) => void;
};

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    writeHead: status => {
      if (typeof status === 'number') res.statusCode = status;
      return res;
    },
    hasHeader: name => name in res.headers,
    setHeader: (name, value) => {
      res.headers[name] = value;
    },
  };
  return res;
}

/** The middleware that wraps writeHead: the one registered function that replaces it on a fake response. */
function challengeMiddleware(): ((req: unknown, res: FakeRes, next: () => void) => void) | undefined {
  return h.useCalls.find(mw => {
    if (typeof mw !== 'function') return false;
    const res = fakeRes();
    const original = res.writeHead;
    try {
      (mw as (req: unknown, res: FakeRes, next: () => void) => void)({ headers: {} }, res, () => {});
    } catch {
      return false;
    }
    return res.writeHead !== original;
  }) as ((req: unknown, res: FakeRes, next: () => void) => void) | undefined;
}

describe('baseApi authChallenge', () => {
  beforeEach(() => {
    h.useCalls.length = 0;
    vi.clearAllMocks();
  });

  it('adds nothing when the route names no challenge', () => {
    baseApi({ auth: true });
    expect(challengeMiddleware()).toBeUndefined();
  });

  it('sets WWW-Authenticate on a 401 whether the status comes from writeHead or statusCode', () => {
    baseApi({ auth: true, authChallenge: 'Bearer' });
    const mw = challengeMiddleware()!;

    const viaStatusCode = fakeRes();
    mw({}, viaStatusCode, () => {});
    viaStatusCode.statusCode = 401;
    viaStatusCode.writeHead();
    expect(viaStatusCode.headers['WWW-Authenticate']).toBe('Bearer');

    const viaArgument = fakeRes();
    mw({}, viaArgument, () => {});
    viaArgument.writeHead(401);
    expect(viaArgument.headers['WWW-Authenticate']).toBe('Bearer');
  });

  it('leaves every other status without the header', () => {
    baseApi({ auth: true, authChallenge: 'Bearer' });
    const res = fakeRes();
    challengeMiddleware()!({}, res, () => {});
    res.writeHead(403);
    res.writeHead(429);
    expect(res.headers['WWW-Authenticate']).toBeUndefined();
  });
});

describe('baseApi skipApiKeyRateLimit', () => {
  beforeEach(() => {
    h.useCalls.length = 0;
    vi.clearAllMocks();
  });

  it('hands the predicate to the API-key limiter', () => {
    const skip = () => true;
    baseApi({ auth: true, skipApiKeyRateLimit: skip });
    expect(h.apiKeyRateLimitMock).toHaveBeenCalledWith(expect.objectContaining({ skip }));
  });
});
