import { classifySideAppRefusal } from '../../auth/sideAppRefusalClass';
import {
  classifyAgentExecutionOutcome,
  classifyQuestOutcome,
  classifyRequestOutcome,
  type StatusClass,
} from '../outcomes';
import { emptyWindowCounts, type ClientHealthInput, type HourlyBucket, type WindowCounts } from './rules';

interface RowBase {
  clientId: string;
  /** Start of the clock hour the rows were grouped into; ignored for the last-hour window. */
  hourStart: number;
  count: number;
}

export type HealthRow =
  | (RowBase & {
      source: 'usage';
      endpoint: string;
      statusClass: StatusClass;
      completionOutcome?: string | null;
      completionFailureCode?: string | null;
    })
  | (RowBase & {
      source: 'quest';
      status?: string | null;
      type?: string | null;
      errorCode?: string | null;
      finishReason?: string | null;
    })
  | (RowBase & { source: 'agent'; status?: string | null })
  | (RowBase & { source: 'refusal'; reason: string });

export type HealthEvent = { kind: 'success' } | { kind: 'failure'; ourFault: boolean; reason: string };

/**
 * Success or failure for one grouped row, by the same rules as the admin board. The ledger is never
 * read: a failed turn or agent run is charged, so a charge proves nothing. Policy refusals and
 * anything unverified (which never reaches these rows) are ignored.
 */
export function classifyHealthRow(row: HealthRow): HealthEvent | null {
  switch (row.source) {
    case 'usage': {
      const outcome = classifyRequestOutcome({
        endpoint: row.endpoint,
        statusClass: row.statusClass,
        completionOutcome: row.completionOutcome as Parameters<typeof classifyRequestOutcome>[0]['completionOutcome'],
      });
      if (outcome === 'completed') return { kind: 'success' };
      if (!outcome) return null;
      const reason =
        row.completionOutcome === outcome
          ? outcome === 'failed' && row.completionFailureCode
            ? `completion_failed ${row.completionFailureCode}`
            : `completion_${outcome}`
          : `http_5xx ${row.endpoint}`;
      return { kind: 'failure', ourFault: true, reason };
    }
    case 'quest': {
      const outcome = classifyQuestOutcome(row);
      if (outcome === 'completed') return { kind: 'success' };
      if (!outcome) return null;
      return { kind: 'failure', ourFault: true, reason: `chat_failed ${row.errorCode || row.finishReason || 'error'}` };
    }
    case 'agent': {
      const outcome = classifyAgentExecutionOutcome(row.status);
      if (outcome === 'completed') return { kind: 'success' };
      if (!outcome) return null;
      return { kind: 'failure', ourFault: true, reason: 'agent_failed' };
    }
    case 'refusal': {
      const faultClass = classifySideAppRefusal(row.reason);
      if (faultClass === 'policy') return null;
      return { kind: 'failure', ourFault: faultClass === 'our_fault', reason: `refused ${row.reason}` };
    }
  }
}

function addEvent(counts: WindowCounts, event: HealthEvent, count: number): void {
  if (event.kind === 'success') {
    counts.successes += count;
    return;
  }
  counts.failures += count;
  if (event.ourFault) counts.ourFaultFailures += count;
  counts.reasons[event.reason] = (counts.reasons[event.reason] ?? 0) + count;
}

/** Fold grouped rows into per-client hourly buckets (trailing GAP_LOOKBACK_DAYS) and last-hour counts. */
export function buildClientInputs(hourlyRows: HealthRow[], lastHourRows: HealthRow[]): ClientHealthInput[] {
  const clients = new Map<string, { hourly: Map<number, HourlyBucket & WindowCounts>; lastHour: WindowCounts }>();
  const client = (clientId: string) => {
    let entry = clients.get(clientId);
    if (!entry) clients.set(clientId, (entry = { hourly: new Map(), lastHour: emptyWindowCounts() }));
    return entry;
  };

  for (const row of hourlyRows) {
    const event = classifyHealthRow(row);
    const entry = client(row.clientId);
    if (!event) continue;
    let bucket = entry.hourly.get(row.hourStart);
    if (!bucket) {
      bucket = { hourStart: row.hourStart, successes: 0, failures: 0, ourFaultFailures: 0, reasons: {} };
      entry.hourly.set(row.hourStart, bucket);
    }
    addEvent(bucket, event, row.count);
  }
  for (const row of lastHourRows) {
    const event = classifyHealthRow(row);
    const entry = client(row.clientId);
    if (event) addEvent(entry.lastHour, event, row.count);
  }

  return [...clients.entries()].map(([clientId, entry]) => ({
    clientId,
    hourly: [...entry.hourly.values()].sort((a, b) => a.hourStart - b.hourStart),
    lastHour: entry.lastHour,
  }));
}
