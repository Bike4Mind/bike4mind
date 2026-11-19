// Well under the web server's 60s Lambda timeout (infra/web.ts): a slow Lambda control plane drops
// logs links instead of failing the admin request.
export const CONSUMER_LOGS_BUDGET_MS = 15_000;

/** Settles each lookup still pending after budgetMs to null, so slow lookups never hold up the caller. */
export async function settleWithinBudget<T>(lookups: Promise<T | null>[], budgetMs: number): Promise<(T | null)[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), Math.max(0, budgetMs));
  });
  try {
    return await Promise.all(lookups.map(lookup => Promise.race([lookup, deadline])));
  } finally {
    clearTimeout(timer);
  }
}
