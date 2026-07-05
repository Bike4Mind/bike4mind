import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Bounded retry wrapper around `MongoMemoryServer.create()` to absorb the
 * ephemeral-port race under parallel test execution.
 *
 * `mongodb-memory-server` picks a free port then spawns `mongod` to bind it.
 * That check-then-bind is racy: when many suites start `mongod` concurrently,
 * two workers can be handed the same just-freed port and the loser dies with
 * `Port "<n>" already in use`. The library has no retry. Each retry re-runs
 * `create()` (fresh port selection), so a collision does not recur on the next
 * attempt. Only port-in-use is retried; every other startup error surfaces at
 * once so real problems are never masked.
 */
// Coupled to the exact wording `mongodb-memory-server-core` emits for a port
// collision (`MongoInstance.ts`). A major version bump can change the message;
// then this regex stops matching and the wrapper degrades to a passthrough (the
// flake returns, but no real error is masked). Revisit on any major upgrade.
const PORT_IN_USE_PATTERN = /Port "\d*" already in use/i;
const MAX_START_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 50;

const isPortInUseError = (error: unknown): boolean => error instanceof Error && PORT_IN_USE_PATTERN.test(error.message);

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Growing backoff with jitter: a fresh port is chosen on the next attempt, but
// jitter desynchronises workers that lost the race together so they don't retry
// in lockstep (the standard retry-storm mitigation).
const backoffMs = (attempt: number) => RETRY_BACKOFF_MS * attempt + Math.floor(Math.random() * RETRY_BACKOFF_MS);

export const createMongoServer = async (): Promise<MongoMemoryServer> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    try {
      return await MongoMemoryServer.create();
    } catch (error) {
      if (!isPortInUseError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < MAX_START_ATTEMPTS) {
        await delay(backoffMs(attempt));
      }
    }
  }

  throw lastError;
};
