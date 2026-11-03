import { z } from 'zod';
import { AdminActionReasonSchema } from './types/entities/adminActionReason';

/**
 * Where an IP block applies. `login` is the automatic failed-login lockout and covers the sign-in
 * routes only; `all` is an admin's fraud block and also covers signup, checkout and AI usage.
 */
export const IP_BLOCK_SCOPES = ['login', 'all'] as const;
export type IpBlockScope = (typeof IP_BLOCK_SCOPES)[number];

/**
 * The kind of route asking whether a request's IP is blocked. `login` is a sign-in or sign-up
 * route and honours both scopes; `app` is any other entry point (checkout, AI usage, every other
 * write) and honours only `all` blocks.
 */
export const IP_BLOCK_SURFACES = ['login', 'app'] as const;
export type IpBlockSurface = (typeof IP_BLOCK_SURFACES)[number];

export const IP_BLOCK_DURATIONS = ['1h', '24h', '7d', '30d', 'permanent'] as const;
export type IpBlockDuration = (typeof IP_BLOCK_DURATIONS)[number];

const HOUR_MS = 60 * 60 * 1000;

/** Milliseconds per duration; null is permanent. */
export const IP_BLOCK_DURATION_MS: Readonly<Record<IpBlockDuration, number | null>> = {
  '1h': HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
  permanent: null,
};

/**
 * Stored as the expiry of a permanent block, so every "still active" query stays a plain
 * `expiresAt > now`. Compare with isPermanentIpBlock rather than against this date directly.
 */
export const PERMANENT_IP_BLOCK_EXPIRES_AT = new Date('9999-12-31T23:59:59.999Z');

export const isPermanentIpBlock = (expiresAt: Date | string): boolean =>
  new Date(expiresAt).getTime() >= PERMANENT_IP_BLOCK_EXPIRES_AT.getTime();

/**
 * The broadest range an admin may block. A /16 is 65,536 IPv4 addresses and a /32 is an IPv6
 * provider allocation; anything wider risks locking out a whole ISP's customers.
 */
export const MIN_IPV4_BLOCK_PREFIX = 16;
export const MIN_IPV6_BLOCK_PREFIX = 32;

export type IpRange = {
  /** The canonical form stored as the block's `ip`: a bare address, or the network address plus `/prefix`. */
  canonical: string;
  family: 4 | 6;
  prefixLength: number;
  /**
   * First and last address as 32 lowercase hex characters (IPv4 as IPv4-mapped IPv6), so a
   * string comparison orders them and a stored range can be matched with `$lte`/`$gte`.
   */
  start: string;
  end: string;
};

const IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;
const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

function parseIPv4Bytes(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4 || !parts.every(part => IPV4_OCTET.test(part))) return null;
  return parts.map(Number);
}

function parseIPv6Bytes(value: string): number[] | null {
  // A zone id (fe80::1%eth0) is link-local only and never a client address worth blocking.
  if (value.includes('%')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    const pieces = part.split(':');
    for (const [index, piece] of pieces.entries()) {
      if (index === pieces.length - 1 && piece.includes('.')) {
        const v4 = parseIPv4Bytes(piece);
        if (!v4) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (IPV6_GROUP.test(piece)) {
        groups.push(parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return groups;
  };

  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  const groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  return groups.flatMap(group => [group >> 8, group & 0xff]);
}

/** 16 bytes for any address, with IPv4 (and IPv4-mapped IPv6) as IPv4-mapped IPv6. */
function addressBytes(address: string): { bytes: number[]; family: 4 | 6 } | null {
  const v4 = parseIPv4Bytes(address);
  if (v4) return { bytes: [...IPV4_MAPPED_PREFIX, ...v4], family: 4 };
  const v6 = parseIPv6Bytes(address);
  if (!v6) return null;
  const isMapped = IPV4_MAPPED_PREFIX.every((byte, index) => v6[index] === byte);
  return { bytes: v6, family: isMapped ? 4 : 6 };
}

const toHex = (bytes: number[]) => bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');

/** RFC 5952 text: lowercase, no leading zeros, the longest run of two or more zero groups as `::`. */
function formatIPv6(bytes: number[]): string {
  const groups = Array.from({ length: 8 }, (_, index) => (bytes[index * 2] << 8) | bytes[index * 2 + 1]);
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < 8;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const hex = groups.map(group => group.toString(16));
  if (bestLength < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

function formatAddress(bytes: number[], family: 4 | 6): string {
  return family === 4 ? bytes.slice(12).join('.') : formatIPv6(bytes);
}

/**
 * Parses a single address or a CIDR range (IPv4 or IPv6). Host bits below the prefix are cleared,
 * so `203.0.113.7/24` becomes `203.0.113.0/24`. Returns null for anything that is not an address.
 * Breadth is not checked here; see ipBlockTargetProblem.
 */
export function parseIpRange(input: string): IpRange | null {
  const trimmed = input.trim();
  const [address, prefixText, ...rest] = trimmed.split('/');
  if (rest.length > 0 || !address) return null;
  const parsed = addressBytes(address);
  if (!parsed) return null;

  const familyBits = parsed.family === 4 ? 32 : 128;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefixLength = prefixText === undefined ? familyBits : Number(prefixText);
  if (prefixLength > familyBits) return null;

  const hostBits = familyBits - prefixLength;
  const start = [...parsed.bytes];
  const end = [...parsed.bytes];
  for (let bit = 0; bit < hostBits; bit += 1) {
    const byteIndex = 15 - Math.floor(bit / 8);
    const mask = 1 << (bit % 8);
    start[byteIndex] &= ~mask & 0xff;
    end[byteIndex] |= mask;
  }

  const network = formatAddress(start, parsed.family);
  return {
    canonical: hostBits === 0 ? network : `${network}/${prefixLength}`,
    family: parsed.family,
    prefixLength,
    start: toHex(start),
    end: toHex(end),
  };
}

/** The 32-hex form of one address, comparable with IpRange.start/end; null when it is not an address. */
export function ipAddressKey(address: string): string | null {
  const parsed = addressBytes(address.trim());
  return parsed ? toHex(parsed.bytes) : null;
}

/** Whether a stored block covers this address: inside its range, or an exact match for a row without one. */
export function ipBlockContains(
  block: { ip: string; rangeStart?: string; rangeEnd?: string },
  address: string
): boolean {
  const key = ipAddressKey(address);
  if (key && block.rangeStart && block.rangeEnd) return block.rangeStart <= key && key <= block.rangeEnd;
  return block.ip === (parseIpRange(address)?.canonical ?? address);
}

/** Why an admin-entered IP or range cannot be blocked, or null when it can. */
export function ipBlockTargetProblem(input: string): string | null {
  const range = parseIpRange(input);
  if (!range) return 'Enter an IPv4 or IPv6 address, or a range such as 203.0.113.0/24.';
  const minimum = range.family === 4 ? MIN_IPV4_BLOCK_PREFIX : MIN_IPV6_BLOCK_PREFIX;
  if (range.prefixLength < minimum) {
    return `Ranges wider than /${minimum} are not allowed for IPv${range.family}.`;
  }
  return null;
}

export const IpBlockTargetSchema = z
  .string()
  .trim()
  .min(1, 'An IP address or range is required')
  .max(64)
  .superRefine((value, ctx) => {
    const problem = ipBlockTargetProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

/** POST /api/security/blocked-ips. */
export const CreateIpBlockRequestSchema = z.object({
  ip: IpBlockTargetSchema,
  scope: z.enum(IP_BLOCK_SCOPES),
  duration: z.enum(IP_BLOCK_DURATIONS),
  reason: AdminActionReasonSchema,
});
export type CreateIpBlockRequest = z.infer<typeof CreateIpBlockRequestSchema>;
