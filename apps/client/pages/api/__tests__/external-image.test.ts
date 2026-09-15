import { describe, it, expect, vi } from 'vitest';
import { rejectIfUnsafe } from '../external-image';

// Captures the raw GET handler past next-connect/auth plumbing, matching the pattern in
// `logout.test.ts` - lets the route-level test below exercise the real request path (query
// parsing, admin gate, rejectIfUnsafe, logging) without a live baseApi chain.
const mockRefs = vi.hoisted(() => ({ getHandler: null as null | ((req: any, res: any) => unknown) }));
vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

describe('rejectIfUnsafe (SSRF guard)', () => {
  it('rejects a non-https protocol', () => {
    expect(rejectIfUnsafe(new URL('http://example.com/a.png'))).toBe('only https URLs are allowed');
  });

  it.each(['localhost', '0.0.0.0'])('rejects loopback host %s', host => {
    expect(rejectIfUnsafe(new URL(`https://${host}/a.png`))).toBe('loopback hosts are not allowed');
  });

  it.each(['::', '::1'])('rejects loopback host %s', host => {
    expect(rejectIfUnsafe(new URL(`https://[${host}]/a.png`))).toBe('loopback hosts are not allowed');
  });

  it('rejects an IPv4-mapped IPv6 address', () => {
    expect(rejectIfUnsafe(new URL('https://[::ffff:169.254.169.254]/a.png'))).toBe(
      'IPv4-mapped IPv6 addresses are not allowed'
    );
  });

  it('rejects private/reserved IPv4 hosts', () => {
    expect(rejectIfUnsafe(new URL('https://169.254.169.254/a.png'))).toBe(
      'private/reserved IPv4 addresses are not allowed'
    );
  });

  it.each(['fe00::1', 'fe40::1', 'fe7f::1', 'fec0::1', 'feff::1'])(
    'rejects private/reserved IPv6 host %s (#1969)',
    host => {
      expect(rejectIfUnsafe(new URL(`https://[${host}]/a.png`))).toBe(
        'private/reserved IPv6 addresses are not allowed'
      );
    }
  );

  it.each(['2001:4860::8888', '2606:4700::1111'])('allows public IPv6 host %s', host => {
    expect(rejectIfUnsafe(new URL(`https://[${host}]/a.png`))).toBeNull();
  });

  it('allows an ordinary public host', () => {
    expect(rejectIfUnsafe(new URL('https://example.com/a.png'))).toBeNull();
  });
});

describe('GET /api/external-image (route-level)', () => {
  it.each(['fe00::1', 'fec0::1'])('rejects a request whose url host is %s (#1969)', async host => {
    const warn = vi.fn();
    const req: any = {
      user: { isAdmin: true },
      query: { url: `https://[${host}]/a.png` },
      logger: { warn, info: vi.fn() },
    };
    const res: any = {};

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow('private/reserved IPv6 addresses are not allowed');
    expect(warn).toHaveBeenCalledWith(
      'Blocked SSRF attempt on /api/external-image',
      expect.objectContaining({ reason: 'private/reserved IPv6 addresses are not allowed' })
    );
  });
});
