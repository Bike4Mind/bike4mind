import { isMongoNetworkError } from '@bike4mind/db-core';

/** Short enough not to matter next to the socket timeout the failed attempt already waited. */
export const MONGO_NETWORK_RETRY_DELAY_MS = 250;

type RetryLogger = { warn: (message: string) => void };

/**
 * Runs an idempotent read, and runs it ONCE more if it died on its socket. The driver's own
 * retryReads covers the cursor-creating `find`, but not the `getMore` that fetches the rest of a
 * large page, so a socket that stalls mid-cursor surfaces here unretried. The driver has already
 * discarded the failed connection, so the second attempt lands on a fresh one.
 *
 * Exactly one retry: a second network failure is an outage, not a blip, and is rethrown. Any
 * non-network error is rethrown untouched on the first attempt.
 */
export async function retryOnceOnMongoNetworkError<T>(
  read: () => Promise<T>,
  options: { label: string; logger?: RetryLogger; delayMs?: number }
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isMongoNetworkError(error)) throw error;
    // Name only: the driver's message carries the database host address.
    options.logger?.warn(`${options.label}: ${(error as Error).name}, retrying once on a fresh connection`);
    await new Promise(resolve => setTimeout(resolve, options.delayMs ?? MONGO_NETWORK_RETRY_DELAY_MS));
    return read();
  }
}
