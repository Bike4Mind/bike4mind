import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';

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

/**
 * Bounded retry wrapper around a `mongodb-memory-server` factory (standalone or replica set) to
 * absorb the ephemeral-port race under parallel test execution.
 *
 * The library picks a free port then spawns `mongod` to bind it. That check-then-bind is racy:
 * when many suites start `mongod` concurrently, two workers can be handed the same just-freed
 * port and the loser dies with `Port "<n>" already in use`. The library has no retry. Each retry
 * re-runs the factory (fresh port selection), so a collision does not recur on the next attempt.
 * Only port-in-use is retried; every other startup error surfaces at once so real problems are
 * never masked - note that replica-set-specific failures (init or election timeout) are therefore
 * NOT retried and surface immediately.
 */
const withPortRetry = async <T>(start: () => Promise<T>): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    try {
      return await start();
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

export const createMongoServer = async (): Promise<MongoMemoryServer> =>
  withPortRetry(() => MongoMemoryServer.create());

/**
 * Single-node replica set. Use this instead of `createMongoServer` whenever a test needs REAL
 * transaction semantics.
 *
 * A standalone mongod cannot run a transaction at all: the first write inside the session fails
 * with `MongoServerError` code 20 ("Transaction numbers are only allowed on a replica set member
 * or mongos"), and `withTransaction` does not classify that as transient, so it rethrows. A
 * transaction-shaped test against `createMongoServer` therefore errors out loudly - it does NOT
 * quietly pass with no transactional guarantee. If you are staring at a code-20 failure, this
 * helper is the fix.
 *
 * Slower to boot - reach for it only when transactionality is the thing under test.
 */
export const createMongoReplSet = async (): Promise<MongoMemoryReplSet> =>
  withPortRetry(() => MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }));
