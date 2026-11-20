import { z } from 'zod';

/**
 * Client identification for long-lived API clients (CONVENTIONS.md section 9).
 *
 * A client that ships as a binary (an SDK pinned in someone's lockfile, a first-party
 * native client) cannot be redeployed with the server, so it declares who it is and the
 * server can tell an outdated build to upgrade with a 426 instead of letting it break on
 * a change it does not understand. Both headers are optional; a request without them is
 * never blocked.
 *
 * Deliberately imports nothing but zod: settings.ts reads the schemas below, and the
 * api-contract barrel pulls in every contract.
 */

export const CLIENT_NAME_HEADER = 'X-Client-Name';
export const CLIENT_VERSION_HEADER = 'X-Client-Version';

// Header values are attacker-sized; anything longer than this is not a real name or version.
const MAX_HEADER_LENGTH = 64;
const CLIENT_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const NUMERIC_IDENTIFIER = /^(?:0|[1-9]\d*)$/;
const DIGITS_ONLY = /^\d+$/;
const ALPHANUMERIC_IDENTIFIER = /^[0-9A-Za-z-]+$/;

export type SemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
};

/** A declared client: a lowercase name and its SemVer 2.0.0 version, both already validated. */
export type ClientIdentity = {
  name: string;
  version: string;
};

/**
 * Parses a SemVer 2.0.0 string (`MAJOR.MINOR.PATCH[-prerelease][+build]`), or returns
 * undefined. Hand-split rather than the spec's single regex so the cost stays linear on
 * hostile input.
 */
export function parseSemVer(value: string): SemVer | undefined {
  if (value.length === 0 || value.length > MAX_HEADER_LENGTH) return undefined;

  const plusIndex = value.indexOf('+');
  const withoutBuild = plusIndex === -1 ? value : value.slice(0, plusIndex);
  if (plusIndex !== -1) {
    const build = value.slice(plusIndex + 1).split('.');
    if (!build.every(identifier => ALPHANUMERIC_IDENTIFIER.test(identifier))) return undefined;
  }

  const dashIndex = withoutBuild.indexOf('-');
  const core = (dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex)).split('.');
  const prerelease = dashIndex === -1 ? [] : withoutBuild.slice(dashIndex + 1).split('.');

  if (core.length !== 3 || !core.every(part => NUMERIC_IDENTIFIER.test(part))) return undefined;
  const isValidPrereleaseIdentifier = (identifier: string) =>
    ALPHANUMERIC_IDENTIFIER.test(identifier) && (!DIGITS_ONLY.test(identifier) || NUMERIC_IDENTIFIER.test(identifier));
  if (!prerelease.every(isValidPrereleaseIdentifier)) return undefined;

  const [major, minor, patch] = core.map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { major, minor, patch, prerelease };
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumeric = DIGITS_ONLY.test(left);
  const rightNumeric = DIGITS_ONLY.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  // SemVer 11.4.3: numeric identifiers always sort before alphanumeric ones.
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** SemVer 2.0.0 precedence: negative when `left` is older, 0 when equal (build metadata ignored), positive when newer. */
export function compareSemVer(left: SemVer, right: SemVer): number {
  const coreDifference = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (coreDifference !== 0) return Math.sign(coreDifference);

  // A pre-release sorts before its release: 1.0.0-rc.1 < 1.0.0.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index++) {
    const difference = comparePrereleaseIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (difference !== 0) return difference;
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

export const ClientNameSchema = z
  .string()
  .max(MAX_HEADER_LENGTH)
  .regex(CLIENT_NAME, 'Client name must be lowercase letters, digits, ".", "_" or "-"');

export const ClientVersionSchema = z
  .string()
  .refine(
    value => parseSemVer(value) !== undefined,
    'Client version must be a SemVer 2.0.0 version (MAJOR.MINOR.PATCH)'
  );

/**
 * The `minimumClientVersions` admin setting: client name -> the oldest version still served.
 * A client absent from the map is never gated.
 */
export const MinimumClientVersionsSchema = z.record(ClientNameSchema, ClientVersionSchema);
export type MinimumClientVersions = z.infer<typeof MinimumClientVersionsSchema>;

type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

function singleHeader(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  // A repeated header is ambiguous about which build is calling, so it identifies nothing.
  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * The client a request declares through `X-Client-Name` + `X-Client-Version`, or undefined
 * when either is absent or malformed. `headers` must have lowercase keys, as both Node's
 * `IncomingMessage.headers` and Lambda Function URL events do.
 *
 * Malformed is treated as absent, never as an error: the gate only ever blocks a client
 * that identified itself well enough to be told what to upgrade to.
 */
export function parseClientIdentity(headers: HeaderBag): ClientIdentity | undefined {
  const name = singleHeader(headers, CLIENT_NAME_HEADER)?.toLowerCase();
  const version = singleHeader(headers, CLIENT_VERSION_HEADER);
  if (!name || !version) return undefined;
  if (!ClientNameSchema.safeParse(name).success || parseSemVer(version) === undefined) return undefined;
  return { name, version };
}

/**
 * The minimum version `client` must upgrade to, or undefined when it may proceed: no
 * minimum is configured for its name, or it is at or above that minimum.
 */
export function requiredClientUpgrade(
  client: ClientIdentity | undefined,
  minimums: MinimumClientVersions
): string | undefined {
  if (!client || !Object.hasOwn(minimums, client.name)) return undefined;
  const minimumVersion = minimums[client.name];
  const minimum = parseSemVer(minimumVersion);
  const declared = parseSemVer(client.version);
  if (!minimum || !declared) return undefined;
  return compareSemVer(declared, minimum) < 0 ? minimumVersion : undefined;
}
