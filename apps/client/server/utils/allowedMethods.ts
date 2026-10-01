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
