/**
 * Returns `target` when it is a same-origin path, otherwise `fallback`. Guards the
 * post-login `?next=` redirect so it can never send a user to another host.
 */
export function safeRedirectPath(target: string | null | undefined, fallback = '/'): string {
  if (!target) return fallback;
  if (!target.startsWith('/')) return fallback;
  return target;
}
