import { createHash, timingSafeEqual } from 'crypto';
import { Resource } from 'sst';

/** Header the persona key travels in; never a user API key or session. */
export const PERSONA_ADMIN_KEY_HEADER = 'x-persona-admin-key';

/** Machine `code` on the 404s, so a client tells "endpoint off on this stage" from "no such persona". */
export const PERSONA_ENDPOINT_OFF_CODE = 'persona_endpoint_off';
export const PERSONA_NOT_FOUND_CODE = 'persona_not_found';

const UNSET_SENTINEL = 'not-configured';
// A short value is a placeholder, not a key worth trusting with account creation.
const MIN_KEY_LENGTH = 32;

/**
 * The stage's PERSONA_ADMIN_KEY (SST secret, else the env var of the same name), or undefined when it
 * is unset, the placeholder, or too short. Undefined turns the persona routes off: they answer 404.
 */
export function readPersonaAdminKey(): string | undefined {
  let value: string | undefined;
  try {
    // Untyped on purpose: the secret is not declared in infra on every stage, so sst-env.d.ts may lack it.
    value = (Resource as unknown as Record<string, { value?: string } | undefined>).PERSONA_ADMIN_KEY?.value;
  } catch {
    // Unlinked: the SST runtime throws in the getter.
  }
  value = value || process.env.PERSONA_ADMIN_KEY;
  if (!value || value === UNSET_SENTINEL || value.length < MIN_KEY_LENGTH) return undefined;
  return value;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time comparison of the presented header against the configured key. Both sides are
 * hashed to a fixed 32 bytes first, so the comparison time does not reveal the key's length either.
 */
export function isValidPersonaAdminKey(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return timingSafeEqual(sha256(provided), sha256(expected));
}
