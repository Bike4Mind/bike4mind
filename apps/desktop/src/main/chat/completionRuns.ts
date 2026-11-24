import { isAxiosError, type AxiosInstance } from 'axios';
import {
  CompletionRunSchema,
  CompletionRunUsageSchema,
  RUN_BUDGET_NOT_RAISED_ERROR_CODE,
  type CompletionRun,
  type CompletionRunBudgetState,
  type CompletionRunUsage,
} from '@bike4mind/common';
import type { BillingPayer } from '@shared/account';

/** Issues the run id an orchestration's completions are grouped under. Same base URL and auth as the app's other API calls. */
export const COMPLETION_RUNS_PATH = '/api/v1/completion-runs';

/**
 * A run is owned by the account that pays for it: the server finds an organization's run only
 * when told the organization, and refuses a completion whose payer differs from its run's.
 */
function runPath(runId: string, suffix: string, payer: BillingPayer | undefined): string {
  const path = `${COMPLETION_RUNS_PATH}/${encodeURIComponent(runId)}/${suffix}`;
  const organizationId = payer?.organization_id;
  return organizationId ? `${path}?${new URLSearchParams({ organization_id: organizationId })}` : path;
}

/** Short, because a turn that finds no run id waits on this before its first request. In ms. */
const MINT_TIMEOUT_MS = 10_000;

/**
 * Ask the server for a new run id. Resolves `undefined` on any failure, reported through `onError`:
 * attribution is bookkeeping, so a missing run must never stop the turn it would have labelled.
 */
export async function requestCompletionRun(
  axios: AxiosInstance,
  rootSessionId: string,
  onError: (message: string) => void,
  budgetCredits?: number,
  payer?: BillingPayer
): Promise<CompletionRun | undefined> {
  try {
    const body = {
      rootSessionId,
      ...(budgetCredits !== undefined ? { budgetCredits } : {}),
      // Omitted for Personal, which is what the server binds a run to without one.
      ...(payer?.organization_id ? { organization_id: payer.organization_id } : {}),
    };
    const response = await axios.post<unknown>(COMPLETION_RUNS_PATH, body, { timeout: MINT_TIMEOUT_MS });
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
  rootSessionId: string,
  budgetCredits?: number,
  payer?: BillingPayer
) => Promise<CompletionRun | undefined>;

export function createCompletionRunMinter(
  onError: (message: string) => void,
  request: typeof requestCompletionRun = requestCompletionRun,
  now: () => number = Date.now
): CompletionRunMinter {
  const inFlight = new Map<string, Promise<CompletionRun | undefined>>();
  const failedAt = new Map<string, number>();
  return (key, axios, rootSessionId, budgetCredits, payer) => {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const failed = failedAt.get(key);
    if (failed !== undefined && now() - failed < MINT_FAILURE_BACKOFF_MS) return Promise.resolve(undefined);
    const minted = request(axios, rootSessionId, onError, budgetCredits, payer)
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

/** A read of a run's settled spend: the summary waits on it, so it is bounded like the mint. In ms. */
const USAGE_TIMEOUT_MS = 10_000;

export type CompletionRunUsageRead = { ok: true; usage: CompletionRunUsage } | { ok: false; reason: string };

/** The server's settled spend for `runId`; a failure comes back as a reason, never a throw. */
export async function readCompletionRunUsage(
  axios: AxiosInstance,
  runId: string,
  payer?: BillingPayer
): Promise<CompletionRunUsageRead> {
  try {
    const response = await axios.get<unknown>(runPath(runId, 'usage', payer), { timeout: USAGE_TIMEOUT_MS });
    const parsed = CompletionRunUsageSchema.safeParse(response.data);
    if (parsed.success) return { ok: true, usage: parsed.data };
    return { ok: false, reason: `unexpected response: ${parsed.error.message}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A budgeted run's ceiling and what is held against it, from the usage read. `undefined` for a
 * run minted without a budget; throws when the read fails.
 */
export async function fetchRunBudget(
  axios: AxiosInstance,
  serverRunId: string,
  payer?: BillingPayer
): Promise<CompletionRunBudgetState | undefined> {
  const read = await readCompletionRunUsage(axios, serverRunId, payer);
  if (!read.ok) throw new Error(`Could not read the run budget: ${read.reason}`);
  return read.usage.budget;
}

/** The new budget was not above the current one (409 run_budget_not_raised). */
export class RunBudgetNotRaisedError extends Error {
  readonly errorCode = RUN_BUDGET_NOT_RAISED_ERROR_CODE;
  constructor(message?: string) {
    super(message || 'The new budget must be higher than the current one.');
    this.name = 'RunBudgetNotRaisedError';
  }
}

/** Raise a run's budget to `budgetCredits`. Rejects with RunBudgetNotRaisedError when it is not a raise. */
export async function raiseRunBudget(
  axios: AxiosInstance,
  serverRunId: string,
  budgetCredits: number,
  payer?: BillingPayer
): Promise<void> {
  try {
    // The budget POST takes its payer in the body, beside budgetCredits; only the GET reads take it in the query.
    const body = { budgetCredits, ...(payer?.organization_id ? { organization_id: payer.organization_id } : {}) };
    await axios.post<unknown>(runPath(serverRunId, 'budget', undefined), body, { timeout: USAGE_TIMEOUT_MS });
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 409) {
      const data: unknown = err.response.data;
      const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
      if (record.errorCode === RUN_BUDGET_NOT_RAISED_ERROR_CODE) {
        throw new RunBudgetNotRaisedError(typeof record.message === 'string' ? record.message : undefined);
      }
    }
    throw err;
  }
}
