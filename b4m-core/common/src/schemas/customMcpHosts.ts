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
 * Cloud instance-metadata endpoints, plus the IPv4 one in its IPv4-mapped and NAT64 IPv6 forms.
 * Never reachable through `customMcpAllowPrivateNetworks`, self-host included.
 */
export const CLOUD_METADATA_ADDRESSES = [
  '169.254.169.254',
  'fd00:ec2::254',
  '::ffff:169.254.169.254',
  '64:ff9b::169.254.169.254',
] as const;

/** Why `raw` may not be allowed as a private network, or null when it may. */
export function customMcpPrivateCidrProblem(raw: string): string | null {
  const cidr = parseCidr(raw);
  if (!cidr) return 'Must be a CIDR such as 10.0.0.0/8 or fd00::/8';
  const minPrefix = CUSTOM_MCP_MIN_CIDR_PREFIX[cidr.version];
  if (cidr.prefix < minPrefix) return `IPv${cidr.version} ranges must be /${minPrefix} or narrower`;
  const metadata = CLOUD_METADATA_ADDRESSES.find(address => cidrContains(cidr, address));
  if (metadata) return `Range covers the cloud metadata address ${metadata}`;
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
