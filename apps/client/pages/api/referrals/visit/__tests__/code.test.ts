import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  baseApiOptions: vi.fn(),
  rateLimitOptions: vi.fn(),
  exists: vi.fn(),
  emit: vi.fn(),
  setCookie: vi.fn(),
  website: '',
}));

vi.mock('@client/config/general', () => ({
  get WEBSITE_URL() {
    return h.website;
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options?: unknown) => {
    h.baseApiOptions(options);
    const chain = {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
        h.handler = fn;
        return {};
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: <T>(fn: T) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => h.rateLimitOptions(options),
}));
vi.mock('@bike4mind/database', () => ({ User: { exists: h.exists } }));
vi.mock('@bike4mind/server-utils/analytics/emitActiveEvent', () => ({
  emitProductEvent: h.emit,
  HOST_PRODUCT_ID: 'bike4mind',
}));
vi.mock('@server/referrals/shareLink', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/referrals/shareLink')>()),
  setReferralCookie: h.setCookie,
}));

await import('../[code]');

const makeRes = () => ({ setHeader: vi.fn(), redirect: vi.fn() });

describe('GET /r/<code>', () => {
  beforeEach(() => {
    h.exists.mockReset().mockResolvedValue({ _id: 'u1' });
    h.emit.mockReset().mockResolvedValue(undefined);
    h.setCookie.mockReset();
    h.website = '';
  });

  it('is public and rate limited per client', () => {
    expect(h.baseApiOptions).toHaveBeenCalledWith({ auth: false });
    expect(h.rateLimitOptions).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'GET /r' }));
  });

  it('stores a known code and sends the visitor to signup', async () => {
    const res = makeRes();
    await h.handler!({ query: { code: 'ABCD2345' } }, res);
    expect(h.exists).toHaveBeenCalledWith({ referralCode: 'abcd2345' });
    expect(h.setCookie).toHaveBeenCalledWith(res, 'abcd2345');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.redirect).toHaveBeenCalledWith(302, '/register');
    expect(h.emit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'referral_link_visit', metadata: { known: true, via: 'direct' } })
    );
  });

  it('still redirects for a code nobody holds, without a cookie', async () => {
    h.exists.mockResolvedValue(null);
    const res = makeRes();
    await h.handler!({ query: { code: 'abcd2345' } }, res);
    expect(h.setCookie).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(302, '/register');
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ metadata: { known: false, via: 'direct' } }));
  });

  it('skips the lookup for a malformed code', async () => {
    const res = makeRes();
    await h.handler!({ query: { code: '<script>' } }, res);
    expect(h.exists).not.toHaveBeenCalled();
    expect(h.setCookie).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(302, '/register');
  });

  it('lands a published-page badge click on the tagged marketing site, cookie set', async () => {
    h.website = 'https://www.example.test';
    const res = makeRes();
    await h.handler!({ query: { code: 'abcd2345', via: 'embed-badge' } }, res);
    expect(h.setCookie).toHaveBeenCalledWith(res, 'abcd2345');
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://www.example.test/?utm_source=shared-artifact&utm_medium=embed-badge&utm_campaign=publish'
    );
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ metadata: { known: true, via: 'embed-badge' } }));
  });

  it('never redirects off-site for a via it does not know', async () => {
    h.website = 'https://www.example.test';
    const res = makeRes();
    await h.handler!({ query: { code: 'abcd2345', via: 'https://evil.example' } }, res);
    expect(res.redirect).toHaveBeenCalledWith(302, '/register');
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ metadata: { known: true, via: 'direct' } }));
  });
});
