import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'dns';
import type http from 'http';
import type https from 'https';
import {
  isPrivateIP,
  isPrivateOrInternalHostname,
  validateUrlForFetch,
  ssrfSafeLookup,
  ssrfSafeHttpAgent,
  ssrfSafeHttpsAgent,
  SSRF_BLOCKED_CODE,
} from './ssrfProtection';

/**
 * Bracketed IPv6 was a live SSRF bypass: `new URL('http://[::1]/').hostname` is `'[::1]'`, and every
 * literal check compared against unbracketed forms, so a bracketed address matched nothing, was then
 * treated as an IP literal (so DNS validation was skipped) and returned valid. Reachable through the
 * LLM URL-fetch path and Files Manager Add-from-URL, and as a `Location:` value it also defeated the
 * per-hop redirect revalidation this module exists to provide.
 */
describe('SSRF - bracketed IPv6 literals', () => {
  it.each([
    ['loopback', 'http://[::1]/'],
    ['loopback with a port', 'http://[::1]:8080/admin'],
    ['unspecified', 'http://[::]/'],
    ['unique-local', 'http://[fd00::1]/'],
    ['link-local', 'http://[fe80::1]/'],
    ['IPv4-mapped metadata endpoint, dotted', 'http://[::ffff:169.254.169.254]/latest/meta-data/'],
    ['IPv4-mapped metadata endpoint, hex', 'http://[::ffff:a9fe:a9fe]/latest/meta-data/'],
    ['IPv4-mapped loopback, hex', 'http://[::ffff:7f00:1]/'],
  ])('refuses %s', async (_label, url) => {
    await expect(validateUrlForFetch(url)).resolves.toMatchObject({ valid: false });
  });

  // IPv4-COMPATIBLE IPv6 (`::x.y.z.w`), the deprecated sibling of the mapped form. Node compresses the
  // dotted spelling to hex, so `[::169.254.169.254]` arrives as `[::a9fe:a9fe]` and matched none of the
  // family prefixes. Narrower exploitability than the mapped form (modern Linux does not translate it
  // to the underlying IPv4), so this is hardening rather than a live path - but it is the same shape.
  it.each([
    ['metadata endpoint, dotted', 'http://[::169.254.169.254]/latest/meta-data/'],
    ['metadata endpoint, hex', 'http://[::a9fe:a9fe]/latest/meta-data/'],
    ['loopback, dotted', 'http://[::127.0.0.1]/'],
    ['loopback, hex', 'http://[::7f00:1]/'],
    ['RFC1918, dotted', 'http://[::10.0.0.5]/'],
    ['fully expanded', 'http://[0:0:0:0:0:0:169.254.169.254]/'],
  ])('refuses IPv4-compatible IPv6: %s', async (_label, url) => {
    await expect(validateUrlForFetch(url)).resolves.toMatchObject({ valid: false });
  });

  it('keeps judging the MAPPED form by its embedded IPv4, not the compatible branch', () => {
    // Ordering guard: `::ffff:1.2.3.4` also starts with `::`, so if the compatible branch ran first it
    // would take `ffff:1.2.3.4` as the tail and miss the embedded address entirely.
    expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
  });

  it('does not refuse public addresses that merely contain an ffff hextet', () => {
    // Boundary for the mapped branch: matching `ffff:` as a SUBSTRING refused these, which is an
    // over-block rather than a hole but a real regression on the live fetch path - and a wide one,
    // since `validateUrlForFetch` sinks a hostname when ANY resolved IP is private, so one `ffff`
    // hextet in a dual-stack host's AAAA would take its healthy A record down with it.
    expect(isPrivateIP('2606:4700:ffff::1')).toBe(false);
    expect(isPrivateIP('2001:4860:ffff::8888')).toBe(false);
    expect(isPrivateOrInternalHostname('[2606:4700:ffff::1]')).toBe(false);
  });

  it('blocks the bracketed forms at the hostname level too', () => {
    expect(isPrivateOrInternalHostname('[::1]')).toBe(true);
    expect(isPrivateOrInternalHostname('[fd00::1]')).toBe(true);
    expect(isPrivateIP('[::1]')).toBe(true);
  });

  it('still recognises the unbracketed forms it always did', () => {
    expect(isPrivateIP('::1')).toBe(true);
    expect(isPrivateIP('fe80::1')).toBe(true);
    expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
  });
});

describe('isPrivateIP - non-canonical (leading-zero) IPv4 octets', () => {
  it('blocks a form that a decimal parser reads as public but inet_aton reads as loopback', () => {
    // `Number('0177')` is 177, so the old check saw 177.0.0.1 and allowed it - while an inet_aton
    // style parser reads 0177 as octal 127 and dials loopback. The string is ambiguous, so it is
    // refused rather than resolved one way and fetched the other.
    expect(isPrivateIP('0177.0.0.1')).toBe(true);
    expect(isPrivateOrInternalHostname('0177.0.0.1')).toBe(true);
  });

  it('blocks a leading-zero octet even where both readings are public', () => {
    // 010 is 8 (octal) or 10 (decimal); we do not care which, only that we cannot know.
    expect(isPrivateIP('010.0.0.1')).toBe(true);
  });

  it('blocks octal forms of the cloud metadata endpoint', () => {
    expect(isPrivateIP('0251.0376.0.0')).toBe(true);
  });

  it('does not over-block canonical addresses, including a legitimate single zero octet', () => {
    expect(isPrivateIP('93.184.216.34')).toBe(false);
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    // A bare '0' octet is canonical - only a zero followed by more digits is ambiguous.
    expect(isPrivateIP('1.0.0.1')).toBe(false);
  });
});

describe('isPrivateIP - RFC 2544 benchmarking range (issue #8157)', () => {
  it('blocks 198.18.0.0/15', () => {
    expect(isPrivateIP('198.18.0.0')).toBe(true);
    expect(isPrivateIP('198.18.0.1')).toBe(true);
    expect(isPrivateIP('198.18.255.255')).toBe(true);
    expect(isPrivateIP('198.19.0.0')).toBe(true);
    expect(isPrivateIP('198.19.255.255')).toBe(true);
  });

  it('blocks the IPv4-mapped IPv6 form of the range', () => {
    expect(isPrivateIP('::ffff:198.18.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:198.17.0.1')).toBe(false);
  });

  it('does not over-block adjacent public ranges', () => {
    expect(isPrivateIP('198.17.255.255')).toBe(false);
    expect(isPrivateIP('198.20.0.0')).toBe(false);
  });

  it('blocks 198.18.x.x literal hostnames', () => {
    expect(isPrivateOrInternalHostname('198.18.0.1')).toBe(true);
    expect(isPrivateOrInternalHostname('198.19.42.42')).toBe(true);
  });
});

/**
 * Three IPv6 families that reached the fetcher untouched. Each was confirmed against this module
 * BEFORE the guards existed - `validateUrlForFetch` returned `{ valid: true }` for every literal
 * below, so these are closed holes rather than defence in depth.
 *
 * The 6to4 case is the sharp one: hextets 2-3 of a `2002::` address ARE an IPv4 address, so
 * `2002:a9fe:a9fe::1` is 169.254.169.254 - instance credentials - in an IPv6 spelling that matched
 * none of the family prefixes.
 */
describe('SSRF - IPv6 families that bypassed the guard (site-local, 6to4, Teredo)', () => {
  it.each([
    ['site-local, low end', 'http://[fec0::1]/'],
    ['site-local, high end', 'http://[feff::1]/'],
    ['6to4 wrapping the metadata endpoint', 'http://[2002:a9fe:a9fe::1]/latest/meta-data/'],
    ['6to4 wrapping loopback', 'http://[2002:7f00:1::1]/'],
    ['6to4 wrapping RFC1918', 'http://[2002:a00:1::1]/'],
    ['Teredo', 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/'],
  ])('refuses %s', async (_label, url) => {
    await expect(validateUrlForFetch(url)).resolves.toMatchObject({ valid: false });
  });

  it('blocks site-local across the whole fec0::/10, not just its first hextet', () => {
    // fe80::/10 stops at febf, so fec0-feff was the uncovered half of the fe80::/9 span.
    expect(isPrivateIP('fec0::1')).toBe(true);
    expect(isPrivateIP('fed0::1')).toBe(true);
    expect(isPrivateIP('fee0::1')).toBe(true);
    expect(isPrivateIP('feff::1')).toBe(true);
  });

  it('judges 6to4 by its prefix, whatever the embedded IPv4 is', () => {
    // Deliberately includes a PUBLIC-embedded address: the prefix ban is wider than "6to4 wrapping a
    // private IPv4" on purpose, because a public-embedded 6to4 address still tunnels via a relay this
    // process neither resolves nor validates.
    expect(isPrivateIP('2002:a9fe:a9fe::1')).toBe(true);
    expect(isPrivateIP('2002:0808:0808::1')).toBe(true);
  });

  it('restricts the Teredo block to a zero second hextet', () => {
    // The boundary that matters: 2001::/16 at large is ordinary public space, so a `2001:` prefix
    // test here would have taken Google and Cloudflare down with it.
    expect(isPrivateIP('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(true);
    expect(isPrivateIP('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIP('2001:4860:ffff::8888')).toBe(false);
  });

  it('catches Teredo when the zero run is compressed away', () => {
    // The `2001:0:` and `2001:0000:` arms both read char 5 expecting a `0`, but RFC 5952 compresses a
    // zero run starting at the second hextet into `::` - so the very hextet those arms match on
    // disappears from the string and these read as public. Both entry paths produce the compressed
    // form: WHATWG URL parsing of a bracketed literal, and getaddrinfo answers.
    expect(isPrivateIP('2001::')).toBe(true);
    expect(isPrivateIP('2001::1')).toBe(true);
    expect(isPrivateIP('2001::a:b:c')).toBe(true);
    // Not a widening: `::` is only legal for a run of 2+ zero hextets, so a canonical `2001::x` always
    // has a zero second hextet and is inside 2001:0::/32. Public 2001: space keeps a non-zero second
    // hextet and so can never compress to this shape - these are the guards on that claim.
    expect(isPrivateIP('2001:4860::8888')).toBe(false);
    expect(isPrivateIP('2001:db9::1')).toBe(false);
  });

  it('leaves public addresses alone, including the neighbours of each new range', () => {
    // Regression pins. `2003::` and `2001:5::` sit immediately outside the two new prefixes, and the
    // Cloudflare pair is the same over-block guard the mapped-form fix needed.
    expect(isPrivateIP('2003::1')).toBe(false);
    expect(isPrivateIP('2001:5::1')).toBe(false);
    expect(isPrivateIP('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateIP('2606:4700:ffff::1')).toBe(false);
    expect(isPrivateOrInternalHostname('[2606:4700:4700::1111]')).toBe(false);
  });

  it('blocks the new families at the hostname level too', () => {
    expect(isPrivateOrInternalHostname('[fec0::1]')).toBe(true);
    expect(isPrivateOrInternalHostname('[2002:a9fe:a9fe::1]')).toBe(true);
    expect(isPrivateOrInternalHostname('[2001:0:4136:e378:8000:63bf:3fff:fdd2]')).toBe(true);
  });
});

/**
 * The two spellings per-hextet prefix matching did not cover. Neither is reachable through the callers
 * in this file - both canonicalise before the predicate sees an address - but this module is offered as
 * a reusable primitive, so it has to hold for input those callers never produce.
 *
 * fe00::/9 is IETF-reserved and unassigned, which is exactly why no arm ever claimed it: the list of
 * arms grew from `fe8`-`feb` to `fec`-`fef` and still stopped short of fe00-fe7f. The mapped form is
 * the same defect one level down, since `::ffff:` is only one of several legal spellings of that
 * prefix. Both are now closed by testing the range instead of listing spellings: one `fe` prefix for
 * the whole /8, and canonicalizing to RFC 5952 before dispatch.
 */
describe('SSRF - IPv6 spellings missed by per-hextet prefix arms (fe00::/9, uncompressed mapped form)', () => {
  it.each([
    ['reserved fe00::/9, low end', 'http://[fe00::1]/'],
    ['reserved fe00::/9, midpoint', 'http://[fe40::1]/'],
    ['reserved fe00::/9, high end', 'http://[fe7f::1]/'],
    // Non-differentiating on purpose, and worth knowing why: WHATWG hexifies the dotted tail, so this
    // arrives as `[::ffff:7f00:1]` and was already refused before the predicate was fixed. It pins the
    // feeder's canonicalisation, not the fix - the predicate-level case below is what demonstrates that.
    ['uncompressed IPv4-mapped loopback', 'http://[0:0:0:0:0:ffff:127.0.0.1]/'],
  ])('refuses %s', async (_label, url) => {
    await expect(validateUrlForFetch(url)).resolves.toMatchObject({ valid: false });
  });

  it('blocks the whole fe00::/8 rather than the ranges someone remembered to list', () => {
    // Boundaries of the span that was open, bracketed by the two arms it used to sit between.
    expect(isPrivateIP('fe00::1')).toBe(true);
    expect(isPrivateIP('fe40::1')).toBe(true);
    expect(isPrivateIP('fe7f::1')).toBe(true);
    expect(isPrivateIP('fe80::1')).toBe(true);
    expect(isPrivateIP('fec0::1')).toBe(true);
    expect(isPrivateIP('feff::1')).toBe(true);
  });

  it('judges the uncompressed IPv4-mapped spelling by its embedded IPv4, both ways', () => {
    // The mapped arm matches on `::ffff:`, so a written-out zero run fell through every branch and read
    // as public. Canonicalizing first makes both spellings the same case - including the negative one:
    // the dotted tail is still decoded exactly rather than blanket-refused.
    expect(isPrivateIP('0:0:0:0:0:ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIP('0:0:0:0:0:ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIP('0000:0000:0000:0000:0000:ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIP('0:0:0:0:0:ffff:8.8.8.8')).toBe(false);
  });

  it('lands other written-out spellings on the arms that already cover them', () => {
    expect(isPrivateIP('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isPrivateIP('0100:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
    expect(isPrivateIP('0064:ff9b:0:0:0:0:1:2')).toBe(true);
    expect(isPrivateIP('2001:0db8:0:0:0:0:0:1')).toBe(true);
  });

  it('leaves public addresses alone, which is what bounds both widenings', () => {
    // Global unicast is 2000::/3, so no public address carries a leading-zero first hextet and none can
    // canonicalise into a `::`-leading or `fe`-leading form. These pin that claim, so a future widening
    // of either rule cannot silently start over-blocking.
    expect(isPrivateIP('2001:4860::8888')).toBe(false);
    expect(isPrivateIP('2606:4700::1111')).toBe(false);
    expect(isPrivateIP('2a00:1450:4001:81b::200e')).toBe(false);
    expect(isPrivateOrInternalHostname('[2001:4860::8888]')).toBe(false);
  });

  it('blocks the new spellings at the hostname level too', () => {
    expect(isPrivateOrInternalHostname('[fe00::1]')).toBe(true);
    expect(isPrivateOrInternalHostname('[0:0:0:0:0:ffff:127.0.0.1]')).toBe(true);
  });

  it('keeps refusing the reserved low space when canonicalisation moves the zero run', () => {
    // The trap in canonicalising before dispatch: RFC 5952 compresses the LONGEST zero run, not the
    // leading one, so these lose the leading `::` the compatible-form arm matches on - `::1:0:0:0:0:0`
    // becomes `0:0:1::`. They are inside the reserved 0000::/16 either way, and were refused before
    // canonicalisation existed, so allowing them would be a regression rather than a new gap.
    expect(isPrivateIP('::1:0:0:0:0:0')).toBe(true);
    expect(isPrivateIP('::ffff:0:0:0:0')).toBe(true);
    expect(isPrivateIP('::fe80:0:0:0:0')).toBe(true);
    expect(isPrivateIP('0:0:1::')).toBe(true);
  });

  it('still refuses zero-padded spellings that are too malformed to canonicalise', () => {
    // `normalizeIpv6` returns input it cannot parse untouched, which is the only path that still reaches
    // the zero-padded prefix arms. Without them these read as public, so this is the guard against
    // deleting those arms as unreachable. An over-long hextet is the reason they bail out here; garbage
    // carrying non-hex letters is refused earlier by the charset gate instead (see below).
    expect(isPrivateIP('2001:0db8:12345::1')).toBe(true);
    expect(isPrivateIP('2001:0000:12345::1')).toBe(true);
    expect(isPrivateIP('0064:ff9b:12345::1')).toBe(true);
    expect(isPrivateIP('0100::12345:1')).toBe(true);
    // Non-hex garbage is not an address in any spelling, so it is not this predicate's `true` to give.
    expect(isPrivateIP('2001:0db8:zz::1')).toBe(false);
  });

  it('refuses the special-purpose ranges IANA assigned after the arm list was written', () => {
    // RFC 9637 documentation and RFC 9602 SRv6 SID space, both 2024. Same category as the 2001:db8::/32
    // arm that already exists, and the reason the list needs range tests rather than remembered prefixes.
    expect(isPrivateIP('3fff::1')).toBe(true);
    expect(isPrivateIP('3fff:fff:ffff::1')).toBe(true);
    expect(isPrivateIP('5f00::1')).toBe(true);
    expect(isPrivateIP('5f00:ffff::1')).toBe(true);
    // The /20 boundary matters: above it is unassigned global unicast IANA can still allocate, so a
    // `3fff:` prefix test would over-block it.
    expect(isPrivateIP('3fff:1000::1')).toBe(false);
    expect(isPrivateIP('3fff:ffff::1')).toBe(false);
    expect(isPrivateIP('5f01::1')).toBe(false);
  });

  it('only decodes an embedded IPv4 from an exact dotted quad', () => {
    // `::ffff:1:2:3:8.8.8.8` is inside reserved 0000::/16 and is NOT a mapped address - hextets 4-6 are
    // non-zero. Judging it by its trailing quad alone let it pass as public.
    expect(isPrivateIP('::ffff:1:2:3:8.8.8.8')).toBe(true);
    expect(isPrivateIP('::1:2:3:8.8.8.8')).toBe(true);
    // The real mapped and compatible forms still resolve through their embedded IPv4, both ways.
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIP('::169.254.169.254')).toBe(true);
    expect(isPrivateIP('::ffff:a9fe:a9fe')).toBe(true);
  });

  it('reads a literal the same whether it carries a port or a zone index', () => {
    // `stripIpv6Brackets` needs the string to END in `]`, so a bracketed literal with a port used to
    // reach the arms still bracketed and match nothing. A zone index is not part of the address either.
    expect(isPrivateIP('[fe80::1]:8080')).toBe(true);
    expect(isPrivateIP('[0:0:0:0:0:ffff:127.0.0.1]:443')).toBe(true);
    expect(isPrivateIP('fe80::1%eth0')).toBe(true);
    expect(isPrivateIP('[2606:4700::1111]:443')).toBe(false);
  });

  it('refuses a dotted quad anywhere but the tail, whatever precedes it', () => {
    // A quad is legal only as the last two hextets. Bailing out on the head-half shape was not enough:
    // with no hex hextet in front, nothing downstream matched and the address read as PUBLIC - the cloud
    // metadata endpoint among them. The shape is refused outright now.
    expect(isPrivateIP('127.0.0.1::')).toBe(true);
    expect(isPrivateIP('169.254.169.254::')).toBe(true);
    expect(isPrivateIP('10.0.0.1::')).toBe(true);
    expect(isPrivateIP('8.8.8.8::')).toBe(true);
    expect(isPrivateIP('2001:db8:1.2.3.4::')).toBe(true);
    expect(isPrivateIP('2606:4700:1.2.3.4::')).toBe(true);
    expect(isPrivateIP('0:1.2.3.4::')).toBe(true);
    expect(isPrivateIP('0:0:1.2.3.4::')).toBe(true);
    // The legal placement still resolves through the embedded address, in both directions, and an IPv4
    // literal with a port stays on the IPv4 path rather than being refused as a misplaced quad.
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIP('8.8.8.8:443')).toBe(false);
    expect(isPrivateIP('10.0.0.1:8080')).toBe(true);
  });

  it('refuses a bracketed literal whose spelling the port strip does not recognise', () => {
    // The strip handles exactly `[addr]:port`. Every neighbouring shape leaves a stray bracket, and those
    // used to fall through the charset gate as public - including `fe80::1]`, which was refused before that
    // gate existed. An address-shaped string this module cannot parse is refused, not waved through.
    expect(isPrivateIP('[fe80::1]:8080:9090')).toBe(true);
    expect(isPrivateIP('[fe80::1]:')).toBe(true);
    expect(isPrivateIP('[fe80::1')).toBe(true);
    expect(isPrivateIP('fe80::1]')).toBe(true);
    expect(isPrivateIP('[2606:4700::1111')).toBe(true);
    // The spellings it does recognise still resolve by address, so a public host is not caught.
    expect(isPrivateIP('[2606:4700::1111]')).toBe(false);
    expect(isPrivateIP('[2606:4700::1111]:443')).toBe(false);
  });

  it('does not read a hostname as an address in a family whose letters it shares', () => {
    // Every family arm is a prefix test and `isPrivateIP` sends all non-dotted-quad input to the IPv6
    // path, so a name starting with the same characters used to match one: `fetch.` and `fe.` hit
    // fe00::/8, `ffmpeg.org` hit multicast, `fdic.gov` hit ULA. Requiring a colon is what separates a
    // spelling of an address from a name that merely looks like one.
    expect(isPrivateIP('fetch.example.com')).toBe(false);
    expect(isPrivateIP('fe.example.com')).toBe(false);
    expect(isPrivateIP('ffmpeg.org')).toBe(false);
    expect(isPrivateIP('fdic.gov')).toBe(false);
    expect(isPrivateIP('fedex.com:8080')).toBe(false);
    // The addresses those names were being confused with are still refused.
    expect(isPrivateIP('fe00::1')).toBe(true);
    expect(isPrivateIP('ff02::1')).toBe(true);
    expect(isPrivateIP('fd00::1')).toBe(true);
    // And name-based blocking still belongs to the hostname predicate, which is unaffected.
    expect(isPrivateOrInternalHostname('localhost')).toBe(true);
    expect(isPrivateOrInternalHostname('metadata.google.internal')).toBe(true);
  });
});

/**
 * The connect-time pin. `validateUrlForFetch` resolving a hostname proves nothing about the address
 * the socket later dials, because the HTTP client resolves it again - so a name answering public then
 * private (DNS rebinding) defeated every URL-level check the module had. These tests drive the two
 * resolutions apart deliberately: the pre-flight is told the name is public, the connect-time lookup
 * is told it is private, and the connection must still be refused.
 */
describe('SSRF - connect-time lookup pin (DNS rebinding)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Drive `ssrfSafeLookup` with a stubbed resolver and collect what it hands back to `net.connect`. */
  const lookupWith = (
    addresses: dns.LookupAddress[] | Error,
    options: dns.LookupOptions = {}
  ): Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }> => {
    vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _opts: unknown, cb: unknown) => {
      const done = cb as (e: Error | null, a?: dns.LookupAddress[]) => void;
      if (addresses instanceof Error) done(addresses);
      else done(null, addresses);
    }) as unknown as typeof dns.lookup);

    return new Promise(resolve => {
      ssrfSafeLookup('host.example.com', options, (err, address, family) => {
        resolve({ err, address, family });
      });
    });
  };

  it('refuses the rebind: a name that resolves to the metadata endpoint at connect time', async () => {
    const { err, address } = await lookupWith([{ address: '169.254.169.254', family: 4 }]);
    expect(err?.code).toBe(SSRF_BLOCKED_CODE);
    expect(err?.message).toContain('169.254.169.254');
    // The address must NOT be handed onward - returning it alongside an error would still let a
    // caller that ignores the error dial the blocked host.
    expect(address).toBe('');
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['RFC1918', '10.0.0.5'],
    ['link-local', '169.254.169.254'],
  ])('refuses a connect-time %s answer', async (_label, ip) => {
    const { err } = await lookupWith([{ address: ip, family: 4 }]);
    expect(err?.code).toBe(SSRF_BLOCKED_CODE);
  });

  it('refuses when only ONE address of a dual-stack record is private', async () => {
    // A dual-stack host must not become reachable just because Node happened to prefer the healthy
    // family on this attempt - which is why the lookup asks for `all` even when the caller did not.
    const { err } = await lookupWith([
      { address: '93.184.216.34', family: 4 },
      { address: '::1', family: 6 },
    ]);
    expect(err?.code).toBe(SSRF_BLOCKED_CODE);
    expect(err?.message).toContain('::1');
  });

  it('blocks the IPv6 families the literal guard blocks, at connect time too', async () => {
    // Same judgement function on both paths, so 6to4 wrapping the metadata endpoint cannot be
    // reintroduced by a DNS answer.
    const { err } = await lookupWith([{ address: '2002:a9fe:a9fe::1', family: 6 }]);
    expect(err?.code).toBe(SSRF_BLOCKED_CODE);
  });

  it('passes a public address through in the single-address shape', async () => {
    const { err, address, family } = await lookupWith([{ address: '93.184.216.34', family: 4 }]);
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('preserves the array shape when the caller asked for all addresses', async () => {
    // Node's socket path asks for ONE address, so it is not what needs this branch. The array shape
    // matters for direct callers of the agent's lookup that pass `all: true` - a bare string would
    // break them, and this test is one such caller.
    const resolved: dns.LookupAddress[] = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    const { err, address } = await lookupWith(resolved, { all: true });
    expect(err).toBeNull();
    expect(address).toEqual(resolved);
  });

  it('errors rather than throwing when a lookup succeeds with no addresses', async () => {
    // Reading addresses[0] on an empty record would throw inside Node's own callback, where there is
    // no caller frame to catch it - so it is reported as an ordinary resolution failure instead.
    const { err, address } = await lookupWith([]);
    expect(err?.code).toBe('ENOTFOUND');
    expect(address).toBe('');
  });

  it('propagates a genuine resolution failure unchanged', async () => {
    // Must stay distinguishable from a block: an unresolvable host is not an attack.
    const { err } = await lookupWith(new Error('ENOTFOUND'));
    expect(err?.message).toBe('ENOTFOUND');
    expect(err?.code).not.toBe(SSRF_BLOCKED_CODE);
  });

  it('installs the pin on both agents and keeps them unpooled', () => {
    // Not cosmetic: a keep-alive socket outlives the lookup that approved it, so a pooled connection
    // would skip the connect-time check on every request after the first.
    //
    // `Agent#options` is populated at runtime but is not on the type @types/node exposes, so reading
    // it needs a cast. Narrowed to the two fields asserted rather than `any`.
    const agentOptions = (agent: http.Agent | https.Agent) =>
      (agent as unknown as { options: { lookup?: unknown; keepAlive?: boolean } }).options;

    expect(agentOptions(ssrfSafeHttpAgent).lookup).toBe(ssrfSafeLookup);
    expect(agentOptions(ssrfSafeHttpsAgent).lookup).toBe(ssrfSafeLookup);
    expect(agentOptions(ssrfSafeHttpAgent).keepAlive).toBe(false);
    expect(agentOptions(ssrfSafeHttpsAgent).keepAlive).toBe(false);
  });
});

/**
 * The generated-corpus checks. Every gap found in this module was a verdict that depended on the SPELLING
 * of an address rather than the address itself, and every one was found by generating spellings and
 * comparing verdicts rather than by reading the code. Hand-picked cases only ever prove the cases someone
 * thought of, so these assert the two properties the arms are supposed to have:
 *
 *   1. spelling invariance - all legal spellings of one address get one verdict;
 *   2. range coverage - a family is refused across its WHOLE prefix, not at the hextets someone listed.
 *
 * Keep these table-driven and cheap. They are the regression net for the defect class, not for a case.
 */
describe('SSRF - IPv6 verdicts follow the address, not its spelling', () => {
  const SPELLINGS: Array<[string, string[], boolean]> = [
    [
      'fe80::1',
      [
        'FE80::1',
        'fe80:0:0:0:0:0:0:1',
        'fe80:0000:0000:0000:0000:0000:0000:0001',
        '[fe80::1]',
        '[fe80::1]:8080',
        'fe80::1%eth0',
      ],
      true,
    ],
    ['fe00::1', ['fe00:0:0:0:0:0:0:1', '[fe00::1]', 'FE00::1'], true],
    ['::1', ['0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '[::1]', '[::1]:8080'], true],
    [
      '::ffff:127.0.0.1',
      ['0:0:0:0:0:ffff:127.0.0.1', '0000:0000:0000:0000:0000:ffff:127.0.0.1', '[::ffff:127.0.0.1]'],
      true,
    ],
    ['::ffff:169.254.169.254', ['0:0:0:0:0:ffff:169.254.169.254', '::ffff:a9fe:a9fe'], true],
    ['::ffff:8.8.8.8', ['0:0:0:0:0:ffff:8.8.8.8', '[::ffff:8.8.8.8]'], false],
    ['3fff::1', ['3fff:0:0:0:0:0:0:1', '[3fff::1]'], true],
    ['5f00::1', ['5f00:0:0:0:0:0:0:1', '[5f00::1]'], true],
    ['2606:4700::1111', ['2606:4700:0:0:0:0:0:1111', '[2606:4700::1111]', '[2606:4700::1111]:443'], false],
    ['2001:4860::8888', ['2001:4860:0:0:0:0:0:8888', '[2001:4860::8888]'], false],
  ];

  it.each(SPELLINGS)('reads %s identically in every legal spelling', (canonical, alternates, expected) => {
    expect(isPrivateIP(canonical)).toBe(expected);
    for (const spelling of alternates) {
      expect(isPrivateIP(spelling), `${spelling} should match ${canonical}`).toBe(expected);
    }
  });

  it('refuses each named family across its whole prefix, not just the listed hextets', () => {
    const hex = (n: number) => n.toString(16).padStart(4, '0');
    const refused: string[] = [];
    // fe00::/8 - every first hextet, which is what the fe8-feb and fec-fef lists kept missing parts of.
    for (let h = 0xfe00; h <= 0xfeff; h++) refused.push(`${hex(h)}::1`);
    // fc00::/7 unique-local and ff00::/8 multicast, sampled across each prefix.
    for (let h = 0xfc00; h <= 0xfdff; h += 7) refused.push(`${hex(h)}::1`);
    for (let h = 0xff00; h <= 0xffff; h += 7) refused.push(`${hex(h)}::1`);
    // 3fff::/20 documentation (RFC 9637) - the in-range half only.
    for (let second = 0x0000; second <= 0x0fff; second += 37) refused.push(`3fff:${hex(second)}::1`);
    // 5f00::/16 SRv6 SIDs (RFC 9602).
    for (let second = 0x0000; second <= 0xffff; second += 271) refused.push(`5f00:${hex(second)}::1`);

    const permitted = refused.filter(ip => !isPrivateIP(ip));
    expect(permitted, `these should be refused: ${permitted.slice(0, 8).join(', ')}`).toEqual([]);
  });

  it('leaves global unicast alone outside the prefixes it names', () => {
    const hex = (n: number) => n.toString(16).padStart(4, '0');
    const public6: string[] = [];
    // 2000::/3 is global unicast. Skip the first hextets this module refuses for a stated reason: 2001:
    // (Teredo / documentation / the 2001::/23 special-purpose block), 2002: (6to4) and 3fff: (documentation).
    for (let h = 0x2000; h <= 0x3fff; h += 11) {
      if (h === 0x2001 || h === 0x2002 || h === 0x3fff) continue;
      public6.push(`${hex(h)}:4700::1111`);
    }
    // Above the 3fff::/20 ceiling is ordinary unassigned global unicast IANA can still allocate.
    for (let second = 0x1000; second <= 0xffff; second += 271) public6.push(`3fff:${hex(second)}::1`);

    const blocked = public6.filter(ip => isPrivateIP(ip));
    expect(blocked, `these should be permitted: ${blocked.slice(0, 8).join(', ')}`).toEqual([]);
  });
});
