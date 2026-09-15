import { createHash } from 'crypto';
import type { ILakeConfigTextFingerprint } from '../types/entities/LakeConfigChangeEventTypes';

/**
 * Lake CONFIG-change audit retention and value caps.
 *
 * Twin of `constants/lakeAccessAudit.ts` and here for the same reason: the values are needed by
 * both the admin-settings schema in this package and by the repository that applies them
 * (`packages/database`, which cannot import an app-server layer).
 *
 * DELIBERATELY NOT the same numbers as the read audit, and deliberately not the same lever. A
 * retrieval is frequent, low-value and cheap to lose; a config change is rare, high-value and
 * alters every future answer the lake gives, so the two want opposite retention. Folding config
 * changes into the read collection would force one of them onto the other's clock - either a
 * config change expiring on a read-volume schedule, or a high-volume collection's storage
 * multiplied to serve a low-volume need.
 *
 * Same one-way ratchet as the read side (#1658's levers rule): `resolveLakeConfigAuditRetentionDays`
 * can only raise a configured value to the floor, never lower it, so an org cannot configure its
 * own retention down to nothing and defeat the control. Platform-level, not per-org: the setting
 * carries no `scope.settableAt`, so #1660's resolver returns the platform value at every scope.
 */

/** 3 years: long enough to outlive a typical contract and audit cycle, on a collection whose
 * volume is a few rows per lake per year. Longer than the read audit's 450 days on purpose - the
 * rarer and more consequential the event, the longer it is worth keeping. */
export const LAKE_CONFIG_AUDIT_RETENTION_FLOOR_DAYS = 1095;
/** A separate constant from the floor on purpose, even though they agree today - a future change
 * to one must not silently move the other. */
export const LAKE_CONFIG_AUDIT_RETENTION_DEFAULT_DAYS = 1095;
/** Ceiling so "adjustable" cannot mean "unbounded" in either direction. */
export const LAKE_CONFIG_AUDIT_RETENTION_MAX_DAYS = 3650;

/**
 * Per-value cap on a stored LITERAL before/after. Bounded config fields are far below this
 * (`name` is capped at 200 and `description` at 2000 by the request schema), so this is a
 * structural backstop against a future field arriving with no cap of its own rather than a limit
 * anyone is expected to hit. Long free text does not reach it at all - it is fingerprinted
 * instead (see LAKE_CONFIG_FINGERPRINTED_FIELDS).
 */
export const LAKE_CONFIG_VALUE_MAX_CHARS = 512;

/** Cap on field changes per event. There are fewer audited fields than this, so it can only fire
 * if the field list grows - a bound on the document, not a policy about which changes matter. */
export const LAKE_CONFIG_MAX_CHANGES = 32;

/** Truncated SHA-256 hex. 32 hex chars is 128 bits, which is far more than enough to answer "is
 * this the same prompt as that one" and keeps the row small. */
export const LAKE_CONFIG_TEXT_HASH_CHARS = 32;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** `undefined` on anything that isn't a finite number once coerced (absent, null, '', NaN, Infinity). */
const toFiniteDaysOrUndefined = (value: number | null | undefined): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
};

/** An unset/blank/non-finite input yields the default; any numeric input is clamped into
 * [FLOOR, MAX] - the floor applies unconditionally, even to an explicit low value. */
export function resolveLakeConfigAuditRetentionDays(configuredDays?: number | null): number {
  const parsed = toFiniteDaysOrUndefined(configuredDays);
  if (parsed === undefined) return LAKE_CONFIG_AUDIT_RETENTION_DEFAULT_DAYS;
  return clamp(parsed, LAKE_CONFIG_AUDIT_RETENTION_FLOOR_DAYS, LAKE_CONFIG_AUDIT_RETENTION_MAX_DAYS);
}

/** The one place `now + days` is computed for this collection, mirroring `lakeAccessExpiresAt`. */
export function lakeConfigExpiresAt(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Describe a long free-text value without reproducing it. Trims first so the fingerprint matches
 * how every read path already treats the prompt (blank in any form reads as absent - see
 * redactLakeForActor), which keeps a whitespace-only edit from registering as a real change.
 *
 * The hash is of the TRIMMED text and is not salted: it is a change/equality marker, not a
 * secret. A short prompt is therefore guessable by an attacker who can already read these audit
 * rows - acceptable, because that same reader is an editor of the lake and can simply open the
 * prompt. What this buys is that the audit COLLECTION never becomes a second copy of it.
 */
export function lakeConfigTextFingerprint(text: string | null | undefined): ILakeConfigTextFingerprint {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return { present: false, length: 0, hash: '' };
  return {
    present: true,
    // Code points, not UTF-16 units, so the length means the same thing for every script.
    length: Array.from(trimmed).length,
    hash: createHash('sha256').update(trimmed).digest('hex').slice(0, LAKE_CONFIG_TEXT_HASH_CHARS),
  };
}

/** Codepoint-safe cap: a plain `.slice(0, N)` counts UTF-16 code units, so it can split a
 * surrogate pair (an emoji, many non-Latin scripts) right at the boundary. */
export function capLakeConfigValue(value: string): { value: string; truncated: boolean } {
  const codepoints = Array.from(value);
  if (codepoints.length <= LAKE_CONFIG_VALUE_MAX_CHARS) return { value, truncated: false };
  return { value: codepoints.slice(0, LAKE_CONFIG_VALUE_MAX_CHARS).join(''), truncated: true };
}
