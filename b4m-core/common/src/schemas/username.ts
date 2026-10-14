import { z } from 'zod';

export const USERNAME_MAX_LENGTH = 64;

export const USERNAME_RULES_MESSAGE = `Usernames can contain letters, numbers, spaces and . _ - ' (up to ${USERNAME_MAX_LENGTH} characters).`;

const USERNAME_PATTERN = /^[\p{L}\p{M}\p{N} ._'-]+$/u;
const DISALLOWED_USERNAME_CHARS = /[^\p{L}\p{M}\p{N} ._'-]/gu;

/**
 * Rules for a username a person picks or an admin sets. Existing stored usernames predate these
 * rules, so callers validate only a new or changed value, never one read back from the database.
 */
export const usernameSchema = z
  .string()
  .trim()
  .min(1, USERNAME_RULES_MESSAGE)
  .max(USERNAME_MAX_LENGTH, USERNAME_RULES_MESSAGE)
  .regex(USERNAME_PATTERN, USERNAME_RULES_MESSAGE);

/**
 * Coerce a machine-derived value (provider display name, email local part) into a username that
 * satisfies {@link usernameSchema}: drops disallowed characters, collapses whitespace and cuts to
 * `maxLength` UTF-16 units without splitting a surrogate pair. May return '' - the caller owns
 * the fallback.
 */
export function sanitizeUsername(raw: string, maxLength: number = USERNAME_MAX_LENGTH): string {
  const collapsed = raw.replace(/\s+/g, ' ').replace(DISALLOWED_USERNAME_CHARS, '').replace(/ {2,}/g, ' ').trim();
  let truncated = '';
  for (const char of collapsed) {
    if (truncated.length + char.length > maxLength) break;
    truncated += char;
  }
  return truncated.trim();
}
