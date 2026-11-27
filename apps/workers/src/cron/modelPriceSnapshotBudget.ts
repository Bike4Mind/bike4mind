/** Optional snapshot work must leave the primary discovery/polling work its invocation headroom. */
export const MODEL_PRICE_SNAPSHOT_BUDGET_MS = 5_000;

export class ModelPriceSnapshotBudgetError extends Error {
  constructor() {
    super('Optional model price snapshot deadline exceeded');
    this.name = 'ModelPriceSnapshotBudgetError';
  }
}

/** A single absolute deadline covers all awaits in one optional stage. */
export function modelPriceSnapshotDeadline(remainingMs?: number, reserveMs = 0): number {
  const availableMs = remainingMs === undefined ? MODEL_PRICE_SNAPSHOT_BUDGET_MS : remainingMs - reserveMs;
  return (
    Date.now() + (Number.isFinite(availableMs) ? Math.max(0, Math.min(MODEL_PRICE_SNAPSHOT_BUDGET_MS, availableMs)) : 0)
  );
}

export async function withModelPriceSnapshotBudget<T>(
  deadlineMs: number,
  work: (signal: AbortSignal, assertActive: () => void) => Promise<T>
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new ModelPriceSnapshotBudgetError();
  const controller = new AbortController();
  const assertActive = () => {
    // Promise continuations can run before a delayed timer callback; check the absolute clock too.
    if (!controller.signal.aborted && Date.now() >= deadlineMs) controller.abort(new ModelPriceSnapshotBudgetError());
    controller.signal.throwIfAborted();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ModelPriceSnapshotBudgetError();
      controller.abort(error);
      reject(error);
    }, remainingMs);
    timer.unref();
  });
  try {
    const pending = (async () => {
      assertActive();
      return work(controller.signal, assertActive);
    })();
    const result = await Promise.race([pending, expired]);
    assertActive();
    return result;
  } finally {
    clearTimeout(timer);
  }
}
