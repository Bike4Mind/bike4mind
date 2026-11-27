import { describe, expect, it } from 'vitest';
import {
  CreateIpBlockRequestSchema,
  ipAddressKey,
  ipBlockContains,
  ipBlockTargetProblem,
  isPermanentIpBlock,
  parseIpRange,
  PERMANENT_IP_BLOCK_EXPIRES_AT,
} from './ipBlock';

const inRange = (range: string, address: string) => {
  const parsed = parseIpRange(range);
  const key = ipAddressKey(address);
  if (!parsed || !key) throw new Error(`unparseable: ${range} / ${address}`);
  return parsed.start <= key && key <= parsed.end;
};

describe('parseIpRange', () => {
  it('keeps a single IPv4 address as itself', () => {
    expect(parseIpRange(' 203.0.113.7 ')).toMatchObject({ canonical: '203.0.113.7', family: 4, prefixLength: 32 });
  });

  it('clears host bits of an IPv4 range', () => {
    expect(parseIpRange('203.0.113.77/24')?.canonical).toBe('203.0.113.0/24');
  });

  it('formats IPv6 per RFC 5952 and clears host bits', () => {
    expect(parseIpRange('2001:DB8:0:0:0:0:0:1')?.canonical).toBe('2001:db8::1');
    expect(parseIpRange('2001:db8:abcd:12::99/48')?.canonical).toBe('2001:db8:abcd::/48');
  });

  it('treats an IPv4-mapped IPv6 address as IPv4', () => {
    expect(parseIpRange('::ffff:198.51.100.4')).toMatchObject({ canonical: '198.51.100.4', family: 4 });
    expect(ipAddressKey('::ffff:198.51.100.4')).toBe(ipAddressKey('198.51.100.4'));
  });

  it.each([
    '',
    'abc',
    '1.2.3',
    '1.2.3.256',
    '01.2.3.4',
    '1.2.3.4/33',
    '1.2.3.4/x',
    '1::2::3',
    '1:2:3:4:5:6:7:8:9',
    'fe80::1%eth0',
    '1.2.3.4/24/1',
  ])('refuses %j', input => {
    expect(parseIpRange(input)).toBeNull();
  });
});

describe('range matching', () => {
  it('matches every address inside an IPv4 range and nothing outside', () => {
    expect(inRange('203.0.113.0/24', '203.0.113.0')).toBe(true);
    expect(inRange('203.0.113.0/24', '203.0.113.255')).toBe(true);
    expect(inRange('203.0.113.0/24', '203.0.114.0')).toBe(false);
    expect(inRange('203.0.113.0/24', '203.0.112.255')).toBe(false);
  });

  it('matches IPv6 ranges and keeps IPv4 and IPv6 apart', () => {
    expect(inRange('2001:db8:abcd::/48', '2001:db8:abcd:ffff::1')).toBe(true);
    expect(inRange('2001:db8:abcd::/48', '2001:db8:abce::1')).toBe(false);
    expect(inRange('2001:db8::/32', '203.0.113.1')).toBe(false);
  });

  it('matches a single address only itself', () => {
    expect(inRange('198.51.100.4', '198.51.100.4')).toBe(true);
    expect(inRange('198.51.100.4', '198.51.100.5')).toBe(false);
  });
});

describe('ipBlockContains', () => {
  it('matches a range row by its bounds', () => {
    const range = parseIpRange('203.0.113.0/24')!;
    const row = { ip: range.canonical, rangeStart: range.start, rangeEnd: range.end };
    expect(ipBlockContains(row, '203.0.113.200')).toBe(true);
    expect(ipBlockContains(row, '::ffff:203.0.113.200')).toBe(true);
    expect(ipBlockContains(row, '203.0.114.1')).toBe(false);
  });

  it('matches a legacy row without range fields on the exact address', () => {
    expect(ipBlockContains({ ip: '198.51.100.4' }, '198.51.100.4')).toBe(true);
    expect(ipBlockContains({ ip: '198.51.100.4' }, '198.51.100.5')).toBe(false);
    expect(ipBlockContains({ ip: 'unknown' }, 'unknown')).toBe(true);
  });
});

describe('ipBlockTargetProblem', () => {
  it('allows ranges down to the breadth limit', () => {
    expect(ipBlockTargetProblem('10.20.0.0/16')).toBeNull();
    expect(ipBlockTargetProblem('2001:db8::/32')).toBeNull();
  });

  it('refuses overly broad ranges', () => {
    expect(ipBlockTargetProblem('10.0.0.0/15')).toMatch(/wider than \/16/);
    expect(ipBlockTargetProblem('0.0.0.0/0')).toMatch(/wider than \/16/);
    expect(ipBlockTargetProblem('2001:db8::/31')).toMatch(/wider than \/32/);
  });

  it('explains an unparseable value', () => {
    expect(ipBlockTargetProblem('not-an-ip')).toMatch(/IPv4 or IPv6/);
  });
});

describe('CreateIpBlockRequestSchema', () => {
  const valid = { ip: '203.0.113.0/24', scope: 'all', duration: '7d', reason: 'Card testing from this range' };

  it('accepts a complete request', () => {
    expect(CreateIpBlockRequestSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['missing reason', { ...valid, reason: undefined }],
    ['short reason', { ...valid, reason: 'x' }],
    ['unknown duration', { ...valid, duration: '2d' }],
    ['unknown scope', { ...valid, scope: 'signup' }],
    ['broad range', { ...valid, ip: '203.0.0.0/8' }],
  ])('refuses a %s', (_label, body) => {
    expect(CreateIpBlockRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('isPermanentIpBlock', () => {
  it('recognises the permanent sentinel only', () => {
    expect(isPermanentIpBlock(PERMANENT_IP_BLOCK_EXPIRES_AT)).toBe(true);
    expect(isPermanentIpBlock(PERMANENT_IP_BLOCK_EXPIRES_AT.toISOString())).toBe(true);
    expect(isPermanentIpBlock(new Date(Date.now() + 1000))).toBe(false);
  });
});
