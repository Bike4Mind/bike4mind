import type { AuthLogger } from '@bike4mind/client-auth';

/**
 * Main-process logger for the shared auth package.
 *
 * Nothing that reaches here may contain a credential: the auth code logs outcomes and error
 * names, never an access token, refresh token or device code. `debug` is dropped in a packaged
 * build so a user's console cannot accumulate request bodies either.
 */
export function createMainLogger(verbose: boolean): AuthLogger {
  return {
    debug(message) {
      if (verbose) console.debug(message);
    },
    warn(message) {
      console.warn(message);
    },
    error(message, err) {
      console.error(message, err instanceof Error ? err.message : '');
    },
  };
}
