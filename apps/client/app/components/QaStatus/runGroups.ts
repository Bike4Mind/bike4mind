import type { QaRunSummary } from '@client/app/hooks/data/qaStatus';

export interface SuiteGroup {
  suite: string;
  /** Newest first. */
  runs: QaRunSummary[];
  failed: number;
}

export interface DayGroup {
  /** Local calendar day, `YYYY-MM-DD`. */
  key: string;
  /** Local midnight of the day. */
  date: Date;
  /** Most recently active suite first. */
  suites: SuiteGroup[];
  runCount: number;
  failed: number;
}

/** A failed run or any failed test. infra-error alone is the env-down warning, not a failure. */
export const isFailingRun = (run: QaRunSummary): boolean => run.counts.failed > 0 || run.status === 'failed';

export function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Today", "Yesterday", else e.g. "Mon, Oct 5" (locale permitting). */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const key = localDayKey(date);
  if (key === localDayKey(now)) return 'Today';
  if (key === localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Groups by local day (newest first), then by suite within the day. */
export function groupRuns(runs: QaRunSummary[]): DayGroup[] {
  const newestFirst = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const days = new Map<string, DayGroup>();
  for (const run of newestFirst) {
    const started = new Date(run.startedAt);
    const key = localDayKey(started);
    let day = days.get(key);
    if (!day) {
      day = {
        key,
        date: new Date(started.getFullYear(), started.getMonth(), started.getDate()),
        suites: [],
        runCount: 0,
        failed: 0,
      };
      days.set(key, day);
    }
    // Runs arrive newest first, so a suite's first sighting is its most recent run.
    let suite = day.suites.find(s => s.suite === run.suite);
    if (!suite) {
      suite = { suite: run.suite, runs: [], failed: 0 };
      day.suites.push(suite);
    }
    const failing = isFailingRun(run);
    suite.runs.push(run);
    day.runCount += 1;
    if (failing) {
      suite.failed += 1;
      day.failed += 1;
    }
  }
  // Map keeps insertion order, which is already newest day first.
  return [...days.values()];
}
