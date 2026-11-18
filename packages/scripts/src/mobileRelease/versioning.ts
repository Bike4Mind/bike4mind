import { parseSemVer, type MinimumClientVersions } from '@bike4mind/common';

/**
 * Mobile train versioning (docs/mobile-release-train.md). A train version is `YY.M.PATCH`: the
 * two-digit year and month of the train cut, then the hotfix number. It is plain SemVer, so the
 * store builds send it as `X-Client-Version` and the `minimumClientVersions` handshake compares it
 * as is.
 */

export type MobilePlatform = 'ios' | 'android';
export const MOBILE_PLATFORMS: readonly MobilePlatform[] = ['ios', 'android'];

// Must match the X-Client-Name each app sends: B4MKit ClientIdentity.swift and kit ClientIdentity.kt.
export const MOBILE_CLIENT_NAMES: Readonly<Record<MobilePlatform, string>> = {
  ios: 'b4m-ios',
  android: 'b4m-android',
};

export const RELEASE_TAG_PREFIX = 'mobile-v';

export type TrainVersion = { year: number; month: number; patch: number };

/** A store build: a train version plus its release-candidate number, absent for the final build. */
export type ReleaseBuild = { version: TrainVersion; rc?: number };

const MAX_PATCH = 99;
const MAX_RC = 98;
// The final build sorts after every rc of the same version, so it takes the slot above the last rc.
const FINAL_BUILD_SLOT = 99;
const RC_NUMBER = /^[1-9]\d*$/;

function isTrainCore(year: number, month: number, patch: number): boolean {
  return year >= 1 && year <= 99 && month >= 1 && month <= 12 && patch <= MAX_PATCH;
}

/** Parses `YY.M.PATCH` (no pre-release, no build metadata), or returns undefined. */
export function parseTrainVersion(value: string): TrainVersion | undefined {
  if (value.includes('+')) return undefined;
  const semver = parseSemVer(value);
  if (!semver || semver.prerelease.length > 0) return undefined;
  const { major: year, minor: month, patch } = semver;
  return isTrainCore(year, month, patch) ? { year, month, patch } : undefined;
}

export function formatTrainVersion({ year, month, patch }: TrainVersion): string {
  return `${year}.${month}.${patch}`;
}

/** The train a version belongs to, `YY.M`: what the parity matrix targets. */
export function trainOf({ year, month }: TrainVersion): string {
  return `${year}.${month}`;
}

/** The `.0` version of the train cut on `date` (UTC). */
export function trainVersionForDate(date: Date): TrainVersion {
  return { year: date.getUTCFullYear() % 100, month: date.getUTCMonth() + 1, patch: 0 };
}

function parseRc(value: string): number | undefined {
  if (!RC_NUMBER.test(value)) return undefined;
  const rc = Number(value);
  return rc <= MAX_RC ? rc : undefined;
}

/** Parses a version plus an optional rc number given separately (the manual workflow inputs). */
export function parseReleaseBuild(version: string, rc?: string): ReleaseBuild | undefined {
  const parsed = parseTrainVersion(version);
  if (!parsed) return undefined;
  if (rc === undefined || rc === '') return { version: parsed };
  const rcNumber = parseRc(rc);
  return rcNumber === undefined ? undefined : { version: parsed, rc: rcNumber };
}

/** Parses a release tag: `mobile-v26.11.0` (final) or `mobile-v26.11.0-rc.3`. */
export function parseReleaseTag(tag: string): ReleaseBuild | undefined {
  if (!tag.startsWith(RELEASE_TAG_PREFIX)) return undefined;
  const rest = tag.slice(RELEASE_TAG_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash === -1) return parseReleaseBuild(rest);
  const suffix = rest.slice(dash + 1);
  const version = parseTrainVersion(rest.slice(0, dash));
  const rc = suffix.startsWith('rc.') ? parseRc(suffix.slice('rc.'.length)) : undefined;
  return version && rc !== undefined ? { version, rc } : undefined;
}

export function formatReleaseTag({ version, rc }: ReleaseBuild): string {
  return `${RELEASE_TAG_PREFIX}${formatTrainVersion(version)}${rc === undefined ? '' : `-rc.${rc}`}`;
}

/**
 * The store build number, `YYMMPPSS`: iOS CFBundleVersion and Android versionCode both use it.
 * It rises with every rc, then the final build, then the next patch, so Play's strictly
 * increasing versionCode and TestFlight's per-version build ordering both hold. The largest
 * (99129999) stays far below Play's versionCode ceiling.
 */
export function buildNumber({ version, rc }: ReleaseBuild): number {
  return version.year * 1_000_000 + version.month * 10_000 + version.patch * 100 + (rc ?? FINAL_BUILD_SLOT);
}

/**
 * Problems with the mobile entries of a `minimumClientVersions` value. A mobile minimum must be a
 * train version: a pre-release minimum never matches what a store build sends.
 */
export function mobileMinimumErrors(minimums: MinimumClientVersions): string[] {
  return MOBILE_PLATFORMS.flatMap(platform => {
    const name = MOBILE_CLIENT_NAMES[platform];
    if (!Object.hasOwn(minimums, name)) return [];
    const value = minimums[name];
    return parseTrainVersion(value) ? [] : [`${name}: "${value}" is not a train version (YY.M.PATCH, e.g. 26.11.0)`];
  });
}
