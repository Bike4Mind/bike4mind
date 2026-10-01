import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The live-pending cap must hold no matter what IP headers the caller sends: the origin can be
 * reached directly, so every header getClientIp reads is caller-controlled.
 */

const mockRefs = vi.hoisted(() => ({ handler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: () => chain,
      post: (fn: any) => {
        mockRefs.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/utils/validators', () => ({ isLocalAppUrl: () => false }));

const repo = vi.hoisted(() => ({ countPendingAndUnexpired: vi.fn(), create: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  deviceAuthorizationRepository: repo,
  digestDeviceCode: (c: string) => `digest:${c}`,
}));

import '../initiate';

function request(ip = '203.0.113.1') {
  const res: any = {
    headers: {} as Record<string, unknown>,
    statusCode: 200,
    body: undefined as unknown,
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const req: any = {
    body: { client_id: 'b4m-cli' },
    headers: { 'x-forwarded-for': ip, 'cloudfront-viewer-address': `${ip}:443`, 'user-agent': 'test' },
    socket: { remoteAddress: ip },
  };
  return { req, res };
}

describe('POST /api/oauth/device/initiate live-pending cap', () => {
  beforeEach(() => {
    repo.countPendingAndUnexpired.mockReset();
    repo.create.mockReset();
  });

  it('creates an authorization below the cap', async () => {
    repo.countPendingAndUnexpired.mockResolvedValue(499);
    const { req, res } = request();
    await mockRefs.handler!(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('device_code');
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('rejects with 503 temporarily_unavailable at the cap and creates nothing', async () => {
    repo.countPendingAndUnexpired.mockResolvedValue(500);
    const { req, res } = request();
    await mockRefs.handler!(req, res);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe(60);
    expect(res.body).toMatchObject({ error: 'temporarily_unavailable' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('holds when every request rotates its IP headers', async () => {
    repo.countPendingAndUnexpired.mockResolvedValue(500);
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      const { req, res } = request(ip);
      await mockRefs.handler!(req, res);
      expect(res.statusCode).toBe(503);
    }
    expect(repo.create).not.toHaveBeenCalled();
  });
});
