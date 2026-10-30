import { describe, it, expect, vi, beforeEach } from 'vitest';

const INGEST_TOKEN = 'ingest-token';

const h = vi.hoisted(() => ({
  persistRateLimitEvents: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => unknown) => (req: unknown, res: unknown) => fn(req, res),
  }),
}));
vi.mock('@bike4mind/server-utils/utils/mcpRateLimitSnapshots', () => ({
  persistRateLimitEvents: h.persistRateLimitEvents,
}));
vi.mock('sst', () => ({ Resource: { RATE_LIMIT_INGEST_TOKEN: { value: 'ingest-token' } } }));

import handler from '../ingest';

type Res = {
  statusCode: number;
  body?: { persisted?: number; error?: string };
  status: (c: number) => Res;
  json: (b: unknown) => Res;
};

function mockRes(): Res {
  const res = { statusCode: 200 } as Res;
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b as Res['body'];
    return res;
  };
  return res;
}

async function post(body: unknown, token = INGEST_TOKEN): Promise<Res> {
  const res = mockRes();
  const req = { headers: { 'x-rate-limit-ingest-token': token }, body };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

const EVENT = { type: 'RATE_LIMIT_WARNING', integration: 'github', usagePercent: 95 };

describe('POST /api/admin/rate-limits/ingest', () => {
  beforeEach(() => {
    h.persistRateLimitEvents.mockReset().mockResolvedValue(1);
  });

  it('stores the events under the posting tenant, not a platform-wide bucket', async () => {
    const res = await post({ events: [EVENT], tenantKey: 'user-1' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ persisted: 1 });
    expect(h.persistRateLimitEvents).toHaveBeenCalledWith([EVENT], 'user-1');
  });

  it('rejects events posted without a tenant so they fall back to the caller-side writer', async () => {
    const res = await post({ events: [EVENT] });

    expect(res.statusCode).toBe(400);
    expect(h.persistRateLimitEvents).not.toHaveBeenCalled();
  });

  it('rejects an empty events array', async () => {
    const res = await post({ events: [], tenantKey: 'user-1' });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a wrong ingest token before reading the body', async () => {
    const res = await post({ events: [EVENT], tenantKey: 'user-1' }, 'wrong-token');

    expect(res.statusCode).toBe(403);
    expect(h.persistRateLimitEvents).not.toHaveBeenCalled();
  });
});
