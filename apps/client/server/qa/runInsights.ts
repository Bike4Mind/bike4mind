import type { QaTestStatus } from '@bike4mind/common';

export interface QaDiffTest {
  testKey: string;
  title: string;
}

/** A run's tests against the previous comparable run (same state key, newest earlier run with tests). */
export interface QaRunDiff {
  previousRunId: string;
  previousStartedAt: string;
  newlyFailing: QaDiffTest[];
  recovered: QaDiffTest[];
  added: QaDiffTest[];
  removed: QaDiffTest[];
}

type TestRef = QaDiffTest & { status: QaTestStatus };

const ref = ({ testKey, title }: QaDiffTest): QaDiffTest => ({ testKey, title });

/** Rounded to a whole ms; null for no values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** Compares by testKey. Newly failing: failed now, passed or flaky before. Recovered: failed before, passed now. */
export function diffTests(
  current: readonly TestRef[],
  previous: readonly TestRef[]
): Pick<QaRunDiff, 'newlyFailing' | 'recovered' | 'added' | 'removed'> {
  const before = new Map(previous.map(t => [t.testKey, t]));
  const now = new Map(current.map(t => [t.testKey, t]));
  const newlyFailing: QaDiffTest[] = [];
  const recovered: QaDiffTest[] = [];
  const added: QaDiffTest[] = [];
  for (const t of current) {
    const prior = before.get(t.testKey);
    if (!prior) added.push(ref(t));
    else if (t.status === 'failed' && (prior.status === 'passed' || prior.status === 'flaky'))
      newlyFailing.push(ref(t));
    else if (t.status === 'passed' && prior.status === 'failed') recovered.push(ref(t));
  }
  const removed = previous.filter(t => !now.has(t.testKey)).map(ref);
  return { newlyFailing, recovered, added, removed };
}
