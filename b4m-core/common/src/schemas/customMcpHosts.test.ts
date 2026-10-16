import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  cidrContains,
  customMcpPrivateCidrProblem,
  CustomMcpPrivateCidrSchema,
  isValidMcpHostPattern,
  McpHostPatternSchema,
  normalizeMcpHostPattern,
  parseCidr,
} from './customMcpHosts';

describe('McpHostPatternSchema', () => {
  it.each([
    ['mcp.example.com', 'mcp.example.com'],
    ['  MCP.Example.COM ', 'mcp.example.com'],
    ['*.example.com', '*.example.com'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['localhost', 'localhost'],
  ])('accepts %j as %j', (raw, normalized) => {
    expect(McpHostPatternSchema.parse(raw)).toBe(normalized);
    expect(isValidMcpHostPattern(normalizeMcpHostPattern(raw))).toBe(true);
  });

  it.each([
    'https://example.com',
    'example.com/mcp',
    'example.com:8443',
    '*',
    '*.',
    'a.*.example.com',
    '-bad.example.com',
    'bad-.example.com',
    'example..com',
    'example.com.',
    'exa mple.com',
    '[::1]',
    '',
    `${'a'.repeat(64)}.com`,
  ])('rejects %j', raw => {
    expect(McpHostPatternSchema.safeParse(raw).success).toBe(false);
  });
});

describe('parseCidr', () => {
  it.each(['10.0.0.0/8', '192.168.1.0/24', 'fd00::/8', '::ffff:10.0.0.0/104', 'FD12:3456::/32'])(
    'parses %s, agreeing with node:net on the address',
    raw => {
      const parsed = parseCidr(raw);
      expect(parsed).not.toBeNull();
      expect(isIP(raw.split('/')[0]!)).toBe(parsed!.version);
    }
  );

  it.each([
    '999.999.999.999/8',
    ':/0',
    '10.0.0.0',
    '10.0.0.0/33',
    '010.0.0.0/8',
    'fd00::/129',
    'fe80::1%eth0/64',
    'example.com/8',
    '1::2::3/64',
  ])('refuses %s', raw => {
    expect(parseCidr(raw)).toBeNull();
  });

  it('expands IPv6 and embedded IPv4 for containment', () => {
    expect(cidrContains(parseCidr('fd00:ec2::/32')!, 'fd00:ec2::254')).toBe(true);
    expect(cidrContains(parseCidr('::ffff:169.254.0.0/112')!, '::ffff:169.254.169.254')).toBe(true);
    expect(cidrContains(parseCidr('10.0.0.0/8')!, '11.0.0.1')).toBe(false);
    expect(cidrContains(parseCidr('10.0.0.0/8')!, 'fd00::1')).toBe(false);
  });
});

describe('customMcpPrivateCidrProblem', () => {
  it.each(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fd12:3456::/32', '169.254.0.0/24'])('allows %s', raw => {
    expect(customMcpPrivateCidrProblem(raw)).toBeNull();
  });

  it.each([
    ['999.999.999.999/8', /CIDR/],
    [':/0', /CIDR/],
    ['0.0.0.0/0', /\/8 or narrower/],
    ['::/0', /\/16 or narrower/],
    ['10.0.0.0/7', /\/8 or narrower/],
    ['169.254.0.0/16', /metadata address 169\.254\.169\.254/],
    ['169.254.169.254/32', /metadata/],
    ['fd00::/16', /metadata address fd00:ec2::254/],
    ['::ffff:0:0/96', /metadata/],
    ['64:ff9b::/96', /metadata/],
  ])('refuses %s', (raw, message) => {
    expect(customMcpPrivateCidrProblem(raw)).toMatch(message);
  });

  it('normalizes before validating', () => {
    expect(CustomMcpPrivateCidrSchema.parse(' FD12:3456::/32 ')).toBe('fd12:3456::/32');
  });
});
