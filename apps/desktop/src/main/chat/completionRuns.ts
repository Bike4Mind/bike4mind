import type { AxiosInstance } from 'axios';
import { CompletionRunSchema, type CompletionRun } from '@bike4mind/common';

/** Issues the run id an orchestration's completions are grouped under. Same base URL and auth as the app's other API calls. */
export const COMPLETION_RUNS_PATH = '/api/v1/completion-runs';

/** Short, because a turn that finds no run id waits on this before its first request. In ms. */
const MINT_TIMEOUT_MS = 10_000;

/**
 * Ask the server for a new run id. Resolves `undefined` on any failure, reported through `onError`:
 * attribution is bookkeeping, so a missing run must never stop the turn it would have labelled.
 */
export async function requestCompletionRun(
  axios: AxiosInstance,
  rootSessionId: string,
  onError: (message: string) => void
): Promise<CompletionRun | undefined> {
  try {
    const response = await axios.post<unknown>(COMPLETION_RUNS_PATH, { rootSessionId }, { timeout: MINT_TIMEOUT_MS });
    const parsed = CompletionRunSchema.safeParse(response.data);
    if (parsed.success) return parsed.data;
    onError(`unexpected response: ${parsed.error.message}`);
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
  }
  return undefined;
}

/**
 * How long a root whose mint failed goes without asking again, in ms. Every turn that finds no run
 * id mints, so without this an unreachable endpoint would hold each turn for MINT_TIMEOUT_MS.
 */
export const MINT_FAILURE_BACKOFF_MS = 60_000;

/**
 * Mints a run id for an orchestration root, at most one request at a time per `key` (the root's
 * local run id): a root and its workers starting turns together share one mint instead of each
 * creating a run of its own. After a failed mint the key answers `undefined` without a request
 * until MINT_FAILURE_BACKOFF_MS has passed.
 */
export type CompletionRunMinter = (
  key: string,
  axios: AxiosInstance,
  rootSessionId: string
) => Promise<CompletionRun | undefined>;

export function createCompletionRunMinter(
  onError: (message: string) => void,
  request: typeof requestCompletionRun = requestCompletionRun,
  now: () => number = Date.now
): CompletionRunMinter {
  const inFlight = new Map<string, Promise<CompletionRun | undefined>>();
  const failedAt = new Map<string, number>();
  return (key, axios, rootSessionId) => {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const failed = failedAt.get(key);
    if (failed !== undefined && now() - failed < MINT_FAILURE_BACKOFF_MS) return Promise.resolve(undefined);
    const minted = request(axios, rootSessionId, onError)
      .then(run => {
        if (run) failedAt.delete(key);
        else failedAt.set(key, now());
        return run;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, minted);
    return minted;
  };
}
