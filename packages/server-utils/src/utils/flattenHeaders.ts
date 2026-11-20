import type { IncomingHttpHeaders } from 'http';

/**
 * Collapse Express/Node headers (`string | string[] | undefined`) to the flat
 * `Record<string, string | undefined>` the auth/origin helpers expect, lowercasing
 * keys and taking the first value of any array. Shared by the embed surfaces so
 * both normalize identically.
 */
export function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    flat[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return flat;
}
