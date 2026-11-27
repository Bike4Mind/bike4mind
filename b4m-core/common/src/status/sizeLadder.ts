import { cmpStr, cmpTime } from './compare';
import { impactSeverity } from './stateOrder';
import { truncateToSchemaCap } from './bounds';
import type { PublicIncidentHead, PublicIncidentIndexRow, PublicSummary } from './schemas.public';

const KB = 1024;

export const STATUS_FILE_SIZE_CAPS = {
  summary: 64 * KB,
  incidents: 256 * KB,
  incident: 1024 * KB,
  incidentHtml: 16 * KB,
  archive: 512 * KB,
  uptime: 256 * KB,
  feed: 256 * KB,
  statusJson: 2 * KB,
  breakglass: 128 * KB,
  external: 1 * KB,
} as const;
export type StatusFileSizeKey = keyof typeof STATUS_FILE_SIZE_CAPS;

export const SUMMARY_LADDER = {
  latestUpdates: [3, 1] as const,
  bodyChars: [1_000, 280] as const,
  maxUpcomingMaintenance: 5,
  maxActiveIncidents: 20,
} as const;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function jsonByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}

export function checkFileSize(
  key: StatusFileSizeKey,
  serialized: string
): { bytes: number; cap: number; withinCap: boolean } {
  const bytes = utf8ByteLength(serialized);
  const cap = STATUS_FILE_SIZE_CAPS[key];
  return { bytes, cap, withinCap: bytes <= cap };
}

export interface SummaryLadderResult {
  summary: PublicSummary;
  /** Ladder steps (1 to 5) that changed the summary, in order. Each one warrants an admin warning. */
  appliedSteps: number[];
  bytes: number;
  /** Still over the cap after the last step; the summary is published anyway. */
  overCap: boolean;
}

function withUpdates(head: PublicIncidentHead, count: number, bodyChars: number): PublicIncidentHead {
  const latestUpdates = head.latestUpdates.slice(0, count).map(update => {
    const cut = truncateToSchemaCap(update.body, bodyChars);
    return cut.truncated ? { ...update, body: cut.text, truncated: true } : update;
  });
  return { ...head, latestUpdates };
}

function mapHeads(summary: PublicSummary, fn: (head: PublicIncidentHead) => PublicIncidentHead): PublicSummary {
  return {
    ...summary,
    activeIncidents: summary.activeIncidents.map(fn),
    upcomingMaintenance: summary.upcomingMaintenance.map(fn),
  };
}

function changed(before: PublicSummary, after: PublicSummary): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function bySeverity(a: PublicIncidentHead, b: PublicIncidentHead): number {
  return impactSeverity(b.impact) - impactSeverity(a.impact) || cmpTime(b.updatedAt, a.updatedAt) || cmpStr(a.id, b.id);
}

/**
 * The summary never refuses to publish. Over the cap, a fixed ladder shrinks it: (1) 3 latest updates
 * per active incident with bodies at 1,000 chars, (2) 1 latest update, (3) bodies at 280 chars,
 * (4) upcoming maintenance limited to 5, (5) the 20 most severe active incidents plus a count.
 */
export function applySummarySizeLadder(
  summary: PublicSummary,
  cap: number = STATUS_FILE_SIZE_CAPS.summary
): SummaryLadderResult {
  let current = summary;
  const appliedSteps: number[] = [];
  const done = (): SummaryLadderResult => {
    const bytes = jsonByteLength(current);
    return { summary: current, appliedSteps, bytes, overCap: bytes > cap };
  };
  const apply = (step: number, next: PublicSummary): boolean => {
    if (changed(current, next)) {
      current = next;
      appliedSteps.push(step);
    }
    return jsonByteLength(current) <= cap;
  };

  if (jsonByteLength(current) <= cap) return done();

  if (
    apply(
      1,
      mapHeads(current, head => withUpdates(head, SUMMARY_LADDER.latestUpdates[0], SUMMARY_LADDER.bodyChars[0]))
    )
  ) {
    return done();
  }
  if (
    apply(
      2,
      mapHeads(current, head => withUpdates(head, SUMMARY_LADDER.latestUpdates[1], SUMMARY_LADDER.bodyChars[0]))
    )
  ) {
    return done();
  }
  if (
    apply(
      3,
      mapHeads(current, head => withUpdates(head, SUMMARY_LADDER.latestUpdates[1], SUMMARY_LADDER.bodyChars[1]))
    )
  ) {
    return done();
  }
  const soonest = [...current.upcomingMaintenance]
    .sort((a, b) => cmpTime(a.scheduledStartAt ?? '', b.scheduledStartAt ?? '') || cmpStr(a.id, b.id))
    .slice(0, SUMMARY_LADDER.maxUpcomingMaintenance);
  if (apply(4, { ...current, upcomingMaintenance: soonest })) return done();

  const ranked = [...current.activeIncidents].sort(bySeverity);
  const kept = ranked.slice(0, SUMMARY_LADDER.maxActiveIncidents);
  apply(5, {
    ...current,
    activeIncidents: kept,
    moreActiveIncidents: current.moreActiveIncidents + (ranked.length - kept.length),
  });
  return done();
}

export interface FittedIndex<Row> {
  rows: Row[];
  dropped: number;
  overCap: boolean;
}

/** Drops the oldest resolved rows until the serialized index fits; unresolved rows are never dropped. */
export function fitIncidentIndex<Row extends Pick<PublicIncidentIndexRow, 'status' | 'startedAt' | 'id'>>(
  rows: Row[],
  measure: (rows: Row[]) => number,
  cap: number
): FittedIndex<Row> {
  if (measure(rows) <= cap) return { rows, dropped: 0, overCap: false };
  const droppable = rows
    .filter(row => row.status === 'resolved' || row.status === 'completed' || row.status === 'cancelled')
    .sort((a, b) => cmpTime(a.startedAt, b.startedAt) || cmpStr(a.id, b.id));
  const without = (count: number): Row[] => {
    const removed = new Set(droppable.slice(0, count));
    return rows.filter(row => !removed.has(row));
  };
  let low = 0;
  let high = droppable.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (measure(without(mid)) <= cap) high = mid;
    else low = mid + 1;
  }
  const kept = without(low);
  return { rows: kept, dropped: low, overCap: measure(kept) > cap };
}
