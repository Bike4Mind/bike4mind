import type { DevLogRecord } from '@shared/devLog';

/** Rows actually mounted. The buffer is larger; a tail nobody can see is not worth a DOM node. */
export const MOUNTED_ROWS = 500;

/** Records the window keeps. Matches the sink's own cap, so a reload shows the same tail. */
export const KEPT_RECORDS = 2000;

/** One tag per source, so the filter bar is a list of sources and alphabetical is the order. */
export function compareTags(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Merge a batch into what the window holds, newest last.
 *
 * Ids are monotonic in main, so this only has to handle the one case that is not append: the
 * opening snapshot resolving after a push has already landed.
 */
export function mergeRecords(
  current: readonly DevLogRecord[],
  incoming: readonly DevLogRecord[],
  cap = KEPT_RECORDS
): DevLogRecord[] {
  if (incoming.length === 0) return current as DevLogRecord[];
  const lastId = current.length > 0 ? current[current.length - 1].id : 0;
  const appended = incoming.filter(record => record.id > lastId);
  if (appended.length === incoming.length) {
    const merged = current.concat(appended);
    return merged.length > cap ? merged.slice(merged.length - cap) : merged;
  }
  const byId = new Map<number, DevLogRecord>();
  for (const record of current) byId.set(record.id, record);
  for (const record of incoming) byId.set(record.id, record);
  const merged = [...byId.values()].sort((a, b) => a.id - b.id);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** No selection shows everything; a selection shows any line carrying any selected tag. */
export function matchesFilter(record: DevLogRecord, selected: ReadonlySet<string>): boolean {
  if (selected.size === 0) return true;
  return record.tags.some(tag => selected.has(tag));
}

export function visibleRecords(records: readonly DevLogRecord[], selected: ReadonlySet<string>): DevLogRecord[] {
  return selected.size === 0 ? (records as DevLogRecord[]) : records.filter(record => matchesFilter(record, selected));
}

function clockTime(at: number): string {
  const time = new Date(at);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}.${pad(time.getMilliseconds(), 3)}`;
}

export function formatRecord(record: DevLogRecord): string {
  const fields = Object.entries(record.fields ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  return [clockTime(record.at), `[${record.tags.join(' ')}]`, record.message, fields].filter(Boolean).join(' ');
}

/** What the copy button puts on the clipboard: exactly the lines on screen, in order. */
export function formatForCopy(records: readonly DevLogRecord[]): string {
  return records.map(formatRecord).join('\n');
}

export { clockTime };
