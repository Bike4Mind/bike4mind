/**
 * Upper-cased allow-list for a 405 guard, with HEAD added wherever GET is served: HEAD is
 * implied by GET (RFC 9110 section 9.3.2), and next-connect's router already serves a HEAD
 * request from the registered GET handler, so a GET route must not 405 it.
 *
 * Shared by both contract transports (middlewares/baseApi.ts, cli/defineLambdaRoute.ts) so the
 * 405 that openapi/registerContract.ts documents for every contract holds on each of them.
 */
export function resolveAllowedMethods(methods: readonly string[]): string[] {
  const upperCased = methods.map(method => method.toUpperCase());
  const getIndex = upperCased.indexOf('GET');
  if (getIndex === -1 || upperCased.includes('HEAD')) return upperCased;
  return [...upperCased.slice(0, getIndex + 1), 'HEAD', ...upperCased.slice(getIndex + 1)];
}

export type MethodGuardResult = { allowed: true } | { allowed: false; allowHeader: string; message: string };

/**
 * The 405 decision every transport makes ahead of auth (middlewares/baseApi.ts,
 * cli/defineLambdaRoute.ts, chatCompletion/external/sseRoute.ts), so the `Allow` value and the
 * error wording cannot drift between them. Each transport still shapes its own response.
 */
export function createMethodGuard(methods: readonly string[]): (method: string | undefined) => MethodGuardResult {
  const allowed = resolveAllowedMethods(methods);
  const allowHeader = allowed.join(', ');
  return method => {
    const upperCased = method?.toUpperCase() ?? '';
    if (allowed.includes(upperCased)) return { allowed: true };
    return { allowed: false, allowHeader, message: `Method ${upperCased} is not allowed. Allowed: ${allowHeader}` };
  };
}
