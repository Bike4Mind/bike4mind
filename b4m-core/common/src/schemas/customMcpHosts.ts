import { z } from 'zod';

/**
 * Host patterns and private-network CIDRs for the custom MCP connector settings (settings.ts).
 *
 * A pattern is a bare hostname (`mcp.example.com`) or a wildcard (`*.example.com`): no scheme,
 * path or port. It is compared against `McpConnection.urlHost`, which is the lowercased hostname
 * without the port, so one pattern covers every port on that host. IDNs are written in punycode.
 *
 * CIDRs are validated with zod's strict `cidrv4`/`cidrv6` rather than `node:net`, because this
 * module is also bundled into the browser for the settings form.
 */

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const MAX_HOSTNAME_LENGTH = 253;
export const CUSTOM_MCP_MAX_HOST_PATTERNS = 500;

export function normalizeMcpHostPattern(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Expects a normalized pattern (see {@link normalizeMcpHostPattern}). */
export function isValidMcpHostPattern(pattern: string): boolean {
  const host = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
  if (host.length === 0 || host.length > MAX_HOSTNAME_LENGTH) return false;
  return host.split('.').every(label => HOST_LABEL.test(label));
}

export const McpHostPatternSchema = z.string().trim().toLowerCase().refine(isValidMcpHostPattern, {
  message: 'Must be a hostname such as mcp.example.com or *.example.com, with no scheme, path or port',
});

export const McpHostPatternListSchema = z.array(McpHostPatternSchema).max(CUSTOM_MCP_MAX_HOST_PATTERNS);

export interface ParsedCidr {
  version: 4 | 6;
  /** Network address, 4 or 16 bytes. Host bits are kept as written; containment masks them. */
  bytes: number[];
  prefix: number;
}

/** Shortest prefix an operator may allow; anything wider is almost certainly a mistake. */
export const CUSTOM_MCP_MIN_CIDR_PREFIX = { 4: 8, 6: 16 } as const;

function ipv6ToBytes(address: string): number[] | null {
  let hex = address;
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!z.ipv4().safeParse(tail).success) return null;
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    hex = `${address.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = hex.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right];

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function addressBytes(address: string): { version: 4 | 6; bytes: number[] } | null {
  if (z.ipv4().safeParse(address).success) return { version: 4, bytes: address.split('.').map(Number) };
  if (z.ipv6().safeParse(address).success) {
    const bytes = ipv6ToBytes(address);
    return bytes ? { version: 6, bytes } : null;
  }
  return null;
}

/** Strict parse: valid octets or IPv6 groups, no zone id, prefix in range. Null when invalid. */
export function parseCidr(raw: string): ParsedCidr | null {
  const value = raw.trim().toLowerCase();
  const isV4 = z.cidrv4().safeParse(value).success;
  if (!isV4 && !z.cidrv6().safeParse(value).success) return null;
  const slash = value.lastIndexOf('/');
  const parsed = addressBytes(value.slice(0, slash));
  if (!parsed || parsed.version !== (isV4 ? 4 : 6)) return null;
  return { ...parsed, prefix: Number(value.slice(slash + 1)) };
}

export function cidrContains(cidr: ParsedCidr, address: string): boolean {
  const target = addressBytes(address);
  if (!target || target.version !== cidr.version) return false;
  for (let bit = 0; bit < cidr.prefix; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if (((cidr.bytes[byte] ?? 0) & mask) !== ((target.bytes[byte] ?? 0) & mask)) return false;
  }
  return true;
}

/**
 * Networks a private-network opt-in never reaches, whatever the operator lists, self-host included.
 * One list for both sides: the settings validator refuses any range that overlaps an entry, and the
 * fetch path (`buildNeverAdmitted` in fab-pipeline's pinnedFetch.ts) refuses these at connect time.
 * IPv4 entries also cover their IPv4-mapped IPv6 forms (`::ffff:0:0/96`) on both sides.
 */
export const NEVER_ADMITTED_NETWORKS = [
  { cidr: '0.0.0.0/8', label: 'this network' },
  { cidr: '127.0.0.0/8', label: 'loopback' },
  { cidr: '169.254.0.0/16', label: 'link-local, including cloud metadata' },
  // Cloud metadata endpoints outside link-local: one in CGNAT space, AWS IMDS over IPv6 (ULA), and
  // the link-local IMDS address in its NAT64 form.
  { cidr: '100.100.100.200/32', label: 'cloud metadata' },
  { cidr: 'fd00:ec2::254/128', label: 'cloud metadata' },
  { cidr: '64:ff9b::a9fe:a9fe/128', label: 'cloud metadata' },
  { cidr: '::/128', label: 'unspecified' },
  { cidr: '::1/128', label: 'loopback' },
  { cidr: 'fe80::/10', label: 'link-local' },
] as const;

const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

/** An IPv4 CIDR in its IPv4-mapped IPv6 form; other CIDRs unchanged. */
function asIpv6(cidr: ParsedCidr): ParsedCidr {
  if (cidr.version === 6) return cidr;
  return { version: 6, bytes: [...IPV4_MAPPED_PREFIX, ...cidr.bytes], prefix: cidr.prefix + 96 };
}

function cidrsOverlap(a: ParsedCidr, b: ParsedCidr): boolean {
  const [left, right] = a.version === b.version ? [a, b] : [asIpv6(a), asIpv6(b)];
  const prefix = Math.min(left.prefix, right.prefix);
  for (let bit = 0; bit < prefix; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if (((left.bytes[byte] ?? 0) & mask) !== ((right.bytes[byte] ?? 0) & mask)) return false;
  }
  return true;
}

const NEVER_ADMITTED_PARSED = NEVER_ADMITTED_NETWORKS.map(entry => ({ ...entry, parsed: parseCidr(entry.cidr)! }));

/** Why `raw` may not be allowed as a private network, or null when it may. */
export function customMcpPrivateCidrProblem(raw: string): string | null {
  const cidr = parseCidr(raw);
  if (!cidr) return 'Must be a CIDR such as 10.0.0.0/8 or fd12:3456::/32';
  const minPrefix = CUSTOM_MCP_MIN_CIDR_PREFIX[cidr.version];
  if (cidr.prefix < minPrefix) return `IPv${cidr.version} ranges must be /${minPrefix} or narrower`;
  const blocked = NEVER_ADMITTED_PARSED.find(entry => cidrsOverlap(cidr, entry.parsed));
  if (blocked) return `Range overlaps ${blocked.cidr} (${blocked.label}), which is never reachable`;
  return null;
}

export const CustomMcpPrivateCidrSchema = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((value, ctx) => {
    const problem = customMcpPrivateCidrProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
