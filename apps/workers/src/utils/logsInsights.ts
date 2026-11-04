import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
  type ResultField,
} from '@aws-sdk/client-cloudwatch-logs';

const DEFAULT_DEADLINE_MS = 25_000;
const POLL_INTERVAL_MS = 1_000;
/** StopQuery is best-effort cleanup; it must not eat the time left for the caller's own work. */
const STOP_TIMEOUT_MS = 2_000;

export type LogsClient = Pick<CloudWatchLogsClient, 'send'>;

export interface LogsInsightsQuery {
  logGroup: string;
  window: { start: Date; end: Date };
  queryString: string;
  limit: number;
}

export interface LogsInsightsOptions {
  client?: LogsClient;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

let defaultClient: CloudWatchLogsClient | undefined;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const rowToObject = (row: ResultField[]): Record<string, string> =>
  Object.fromEntries(
    row.filter(f => f.field && f.value !== undefined).map(f => [f.field as string, f.value as string])
  );

/**
 * Runs the query and waits for it. Every call shares one deadline signal, so a hung request cannot
 * outlive it either; a query left running on any failure is stopped.
 */
export async function runLogsInsightsQuery(
  query: LogsInsightsQuery,
  options: LogsInsightsOptions = {}
): Promise<ResultField[][]> {
  const client = options.client ?? (defaultClient ??= new CloudWatchLogsClient({}));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const deadline = now() + deadlineMs;
  const abortSignal = AbortSignal.timeout(deadlineMs);
  const timedOut = () => new Error('Logs Insights query did not finish in time');

  let queryId: string | undefined;
  let settled = false;
  try {
    const started = await client.send(
      new StartQueryCommand({
        logGroupName: query.logGroup,
        startTime: Math.floor(query.window.start.getTime() / 1000),
        endTime: Math.ceil(query.window.end.getTime() / 1000),
        queryString: query.queryString,
        limit: query.limit,
      }),
      { abortSignal }
    );
    queryId = started.queryId;
    if (!queryId) throw new Error('Logs Insights returned no query id');

    for (;;) {
      const result = await client.send(new GetQueryResultsCommand({ queryId }), { abortSignal });
      const status = result.status ?? 'Unknown';
      if (status === 'Complete') {
        settled = true;
        return result.results ?? [];
      }
      if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
        settled = true;
        throw new Error(`Logs Insights query ${status.toLowerCase()}`);
      }
      if (now() >= deadline) throw timedOut();
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    throw abortSignal.aborted ? timedOut() : error;
  } finally {
    if (queryId && !settled) {
      await client
        .send(new StopQueryCommand({ queryId }), { abortSignal: AbortSignal.timeout(STOP_TIMEOUT_MS) })
        .catch(() => undefined);
    }
  }
}
