/**
 * Joins a greeting with the user's first name; omits the name when no display name is set.
 * Sign-up stores the username as `name` until the user edits it, so a name equal to the username is
 * treated as unset rather than greeting people with a machine-looking handle.
 */
export function formatGreeting(greeting: string, displayName?: string | null, username?: string | null): string {
  const trimmed = displayName?.trim();
  if (!trimmed || (username && trimmed.toLowerCase() === username.trim().toLowerCase())) return greeting;
  const firstName = trimmed.split(/\s+/)[0];
  return `${greeting}, ${firstName}`;
}
