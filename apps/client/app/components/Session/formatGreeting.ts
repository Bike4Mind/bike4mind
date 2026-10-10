/** Joins a greeting with the user's first name; omits the name when no display name is set. */
export function formatGreeting(greeting: string, displayName?: string | null): string {
  const firstName = displayName?.trim().split(/\s+/)[0];
  return firstName ? `${greeting}, ${firstName}` : greeting;
}
