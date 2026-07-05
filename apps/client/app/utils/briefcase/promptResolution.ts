import type { IPromptContext } from '@bike4mind/common';

/**
 * Click-time template resolution for briefcase prompts. Pure and DOM-free so it
 * is unit-testable and reusable on any surface.
 */

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/**
 * Replace every `{{key}}` in `promptText` with the matching context value.
 *
 * Invariants (see the briefcase blueprint's Test Patterns):
 *  - SINGLE PASS: each placeholder is resolved exactly once against the ORIGINAL
 *    template - a value that itself contains `{{x}}` is never re-substituted.
 *  - Unknown placeholders are left untouched.
 *  - null/undefined values are skipped (the placeholder is left untouched - no
 *    literal "null"/"undefined" leaks into the prompt).
 *  - The FUNCTION form of replace is used so `$&`, `$1`, `$$` etc. in a value
 *    are inserted literally rather than interpreted as replacement patterns.
 */
export function replacePromptVariables(promptText: string, context: IPromptContext): string {
  const ctx = context as Record<string, unknown>;
  return promptText.replace(PLACEHOLDER_RE, (match, key: string) => {
    const value = ctx[key];
    if (value === null || value === undefined) return match;
    return String(value);
  });
}

/** Count placeholders left unresolved after substitution (a quality signal). */
export function countUnresolvedPlaceholders(text: string): number {
  const matches = text.match(PLACEHOLDER_RE);
  return matches ? matches.length : 0;
}

/** Minimal user shape consumed by buildPromptContext - host maps its record on. */
export interface PromptContextUser {
  name?: string;
  email?: string;
  role?: string;
}

/**
 * Build a fresh substitution context from the signed-in user, the selected org,
 * and the current clock. `now` is injectable for deterministic tests.
 */
export function buildPromptContext(
  user: PromptContextUser | null,
  organizationName: string | null,
  now: Date = new Date()
): IPromptContext {
  return {
    organization: organizationName ?? undefined,
    userName: user?.name ?? undefined,
    userEmail: user?.email ?? undefined,
    userRole: user?.role ?? undefined,
    currentDateTime: now.toISOString(),
    currentDate: now.toISOString().slice(0, 10),
    currentTime: now.toISOString().slice(11, 19),
    currentYear: String(now.getUTCFullYear()),
  };
}
