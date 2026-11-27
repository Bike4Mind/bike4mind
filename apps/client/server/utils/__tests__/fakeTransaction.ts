// Mirrors withTransaction/runAfterCommit in b4m-core/db-core/src/utils/mongo.ts: each callback run gets a
// fresh after-commit queue, and only the run that commits drains it.
type Work = () => Promise<unknown>;
type FakeSession = { afterCommit: Map<string, Work> };

export const fakeTransaction = {
  outcome: 'commit' as 'commit' | 'retryOnce' | 'abort',
  runs: 0,
  reset() {
    this.outcome = 'commit';
    this.runs = 0;
  },
};

export async function withTransaction<T>(fn: (session: FakeSession) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const session: FakeSession = { afterCommit: new Map() };
    fakeTransaction.runs++;
    const result = await fn(session);
    if (fakeTransaction.outcome === 'abort') throw new Error('Transaction aborted');
    if (fakeTransaction.outcome === 'retryOnce' && attempt === 0) continue;
    for (const work of session.afterCommit.values()) await work().catch(() => undefined);
    return result;
  }
}

export function runAfterCommit(session: FakeSession, key: string, work: Work): boolean {
  session.afterCommit.set(key, work);
  return true;
}
