import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cachedFailOpenLookup,
  DEFAULT_CLUSTER_KEY_OPTIONS,
  domainClusterKeys,
  localPartShape,
  signupClusterKeys,
  signupRegistrableDomain,
  toSignupRecord,
} from './signupClusterKeys';

const kindsOf = (keys: { kind: string }[]) => keys.map(key => key.kind);

describe('signupRegistrableDomain', () => {
  it('collapses subdomains to the registrable domain', () => {
    expect(signupRegistrableDomain('a@mail.sample.example')).toBe('sample.example');
    expect(signupRegistrableDomain('a@Sample.Example')).toBe('sample.example');
    expect(signupRegistrableDomain('no-at-sign')).toBeNull();
  });

  it('maps a Unicode domain and its punycode form to the same domain', () => {
    const ascii = signupRegistrableDomain('a@xn--r8jz45g.jp');
    expect(ascii).toBe('xn--r8jz45g.jp');
    expect(signupRegistrableDomain('a@\u4f8b\u3048.jp')).toBe(ascii);
  });
});

describe('localPartShape', () => {
  it.each([
    ['jane.doe@x.example', 'alpha+sep+alpha'],
    ['sam2041@x.example', 'alpha+digits'],
    ['sam2041+promo@x.example', 'alpha+digits'],
    ['lee7b@x.example', 'alpha+digits+alpha'],
    ['a!b@x.example', 'alpha+other+alpha'],
  ])('%s -> %s', (email, shape) => {
    expect(localPartShape(email)).toBe(shape);
  });

  it('classifies a hex run that has at least two letters and two digits', () => {
    expect(localPartShape('9f8e7d6c@x.example')).toBe('hex');
    expect(localPartShape('x.9f8e7d6c@x.example')).toBe('alpha+sep+hex');
    expect(localPartShape('12ab@x.example', 4)).toBe('hex');
  });

  it('does not read a run with one letter or one digit as hex', () => {
    expect(localPartShape('1abcde@x.example', 4)).toBe('digits+alpha');
    expect(localPartShape('12345a@x.example', 4)).toBe('digits+alpha');
    expect(localPartShape('12abq@x.example', 4)).toBe('digits+alpha');
  });

  it('returns null without a local part', () => {
    expect(localPartShape('@x.example')).toBeNull();
    expect(localPartShape('+tag@x.example')).toBeNull();
  });
});

describe('domainClusterKeys', () => {
  it('normalizes MX and nameserver sets into one key each', () => {
    const keys = domainClusterKeys({
      mxHosts: ['MX2.Mail.Example.', 'mx1.mail.example', 'mx1.mail.example'],
      nameservers: ['ns1.dns.example'],
    });
    expect(keys).toEqual([
      { kind: 'mx', value: 'mx1.mail.example,mx2.mail.example', label: 'MX hosts mx1.mail.example,mx2.mail.example' },
      { kind: 'ns', value: 'ns1.dns.example', label: 'nameservers ns1.dns.example' },
    ]);
  });

  it('drops hosts of ignored shared providers', () => {
    const options = { ...DEFAULT_CLUSTER_KEY_OPTIONS, ignoredInfrastructureHosts: ['provider.example'] };
    expect(domainClusterKeys({ mxHosts: ['mx1.provider.example', 'provider.example'] }, options)).toEqual([]);
    expect(domainClusterKeys({ mxHosts: ['mx1.provider.example', 'mx.own.example'] }, options)[0].value).toBe(
      'mx.own.example'
    );
  });

  it('puts registrations under half a bucket apart in a shared bucket and far-apart ones in none', () => {
    const options = { ...DEFAULT_CLUSTER_KEY_OPTIONS, registrationBucketDays: 10 };
    const at = (iso: string) =>
      new Set(
        domainClusterKeys({ registrar: 'Registrar Example', registeredAt: new Date(iso) }, options).map(k => k.value)
      );
    const base = at('2026-03-10T00:00:00Z');
    expect([...at('2026-03-14T00:00:00Z')].some(value => base.has(value))).toBe(true);
    expect([...at('2026-04-10T00:00:00Z')].some(value => base.has(value))).toBe(false);
  });

  it('yields no keys for missing facts', () => {
    expect(domainClusterKeys(null)).toEqual([]);
    expect(domainClusterKeys({ registrar: 'Registrar Example' })).toEqual([]);
    expect(domainClusterKeys({ mxHosts: [], nameservers: [' '] })).toEqual([]);
  });
});

describe('signupClusterKeys', () => {
  const record = toSignupRecord({
    userId: 'u1',
    email: 'sam2041@x.example',
    asn: 64500,
    createdAt: new Date('2026-03-10T00:00:00Z'),
  });

  it('drops the email and keeps the derived fields', () => {
    expect(record).toEqual({
      userId: 'u1',
      domain: 'x.example',
      localPartShape: 'alpha+digits',
      createdAt: new Date('2026-03-10T00:00:00Z'),
      asn: 64500,
      isDatacenter: null,
    });
  });

  it('emits no shape key unless the caller names the shape', () => {
    expect(kindsOf(signupClusterKeys(record))).toEqual(['asn', 'signupWindow', 'signupWindow']);
    const options = { ...DEFAULT_CLUSTER_KEY_OPTIONS, localPartShapes: ['alpha+digits'] };
    expect(kindsOf(signupClusterKeys(record, options))[0]).toBe('localPartShape');
    expect(kindsOf(signupClusterKeys(record, { ...options, localPartShapes: 'any' }))[0]).toBe('localPartShape');
  });
});

describe('cachedFailOpenLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('looks each domain up once', async () => {
    const lookup = vi.fn(async () => ({ mxHosts: ['mx.mail.example'] }));
    const cached = cachedFailOpenLookup(lookup);
    await cached('a.example');
    await cached('a.example');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('reports asynchronous lookup failures by default and retries the failed domain', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error('DNS unavailable');
    const facts = { mxHosts: ['mx.mail.example'] };
    const lookup = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(facts);
    const cached = cachedFailOpenLookup(lookup);

    expect(await cached('a.example')).toBeNull();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      '[signup-cluster-keys] Domain facts lookup failed for a.example:',
      error
    );
    expect(await cached('a.example')).toEqual(facts);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight lookup and reports its failure once', async () => {
    const error = new Error('DNS unavailable');
    const lookup = vi.fn(async () => {
      throw error;
    });
    const onError = vi.fn();
    const cached = cachedFailOpenLookup(lookup, onError);
    const first = cached('a.example');
    const second = cached('a.example');

    expect(first).toBe(second);
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith('a.example', error);
  });

  it('propagates reporter errors and still retries the failed lookup', async () => {
    const error = new Error('reporter failed');
    const facts = { nameservers: ['ns.dns.example'] };
    const lookup = vi.fn().mockRejectedValueOnce(new Error('DNS unavailable')).mockResolvedValueOnce(facts);
    const onError = vi.fn(() => {
      throw error;
    });
    const cached = cachedFailOpenLookup(lookup, onError);

    await expect(cached('a.example')).rejects.toBe(error);
    expect(await cached('a.example')).toEqual(facts);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('resolves a failure to null and retries it on the next call', async () => {
    const onError = vi.fn();
    const lookup = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('lookup unavailable');
      })
      .mockResolvedValueOnce({ nameservers: ['ns.dns.example'] });
    const cached = cachedFailOpenLookup(lookup, onError);
    expect(await cached('a.example')).toBeNull();
    expect(onError).toHaveBeenCalledWith('a.example', expect.any(Error));
    expect(await cached('a.example')).toEqual({ nameservers: ['ns.dns.example'] });
  });
});

describe('cluster key guards', () => {
  const record = {
    userId: 'u',
    domain: 'x.example',
    localPartShape: null,
    createdAt: null,
    asn: null,
    isDatacenter: null,
  };

  it('emits no ASN key for a NaN or infinite ASN', () => {
    expect(kindsOf(signupClusterKeys({ ...record, asn: Number.NaN }))).not.toContain('asn');
    expect(kindsOf(signupClusterKeys({ ...record, asn: Infinity }))).not.toContain('asn');
    expect(kindsOf(signupClusterKeys({ ...record, asn: 64500 }))).toContain('asn');
  });

  it.each([0, -1, Number.NaN, Infinity])('rejects a signup bucket width of %s', hours => {
    const options = { ...DEFAULT_CLUSTER_KEY_OPTIONS, signupBucketHours: hours };
    expect(() => signupClusterKeys({ ...record, createdAt: new Date('2026-03-10T00:00:00Z') }, options)).toThrow(
      /signupBucketHours must be a positive finite number/
    );
  });

  it.each([0, -1, Number.NaN, Infinity])('rejects a registration bucket width of %s', days => {
    const options = { ...DEFAULT_CLUSTER_KEY_OPTIONS, registrationBucketDays: days };
    expect(() =>
      domainClusterKeys({ registrar: 'Registrar Example', registeredAt: new Date('2026-03-10T00:00:00Z') }, options)
    ).toThrow(/registrationBucketDays must be a positive finite number/);
  });
});
