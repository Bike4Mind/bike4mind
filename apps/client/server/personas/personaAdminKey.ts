import { timingSafeEqual } from 'crypto';
import { Resource } from 'sst';

/** Header the persona key travels in; never a user API key or session. */
export const PERSONA_ADMIN_KEY_HEADER = 'x-persona-admin-key';

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

/** Constant-time comparison of the presented header against the configured key. */
export function isValidPersonaAdminKey(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  // timingSafeEqual throws on unequal lengths, so compare byte lengths first.
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}
