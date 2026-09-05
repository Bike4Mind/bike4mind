/**
 * Waiting out the audit trail's un-awaited write.
 *
 * `recordLakeAccessEvent` resolves the audit retention settings before calling `record()`, and
 * `search_knowledge_base` does not await the result - so the event lands a few microtasks after
 * `toolFn` returns. Polling beats a fixed sleep: the settings read is cached, so this almost always
 * succeeds on the first tick.
 *
 * Pure and separate from the live driver only so it can be tested at all - `recall-probe.ts` calls
 * `main()` on import, so nothing that lives there can be unit tested. Timing is injectable for the
 * same reason.
 */

export type PollOptions = {
  /** Total wall clock to wait before giving up. */
  timeoutMs?: number;
  /** Macrotask gap between polls, so a pending I/O continuation is not starved by a tight loop. */
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Poll `read` until it yields a value or the deadline passes.
 *
 * Returns `null` on timeout rather than throwing, deliberately: `readServedDocuments` is the single
 * place a missing event is told apart from an honest empty result, and that decision has to stay in
 * one testable spot rather than being pre-empted by an exception thrown here. The caller only
 * invokes this once the status seam has already confirmed content WAS served, so a `null` from here
 * is unambiguously a stalled write.
 *
 * Checks once BEFORE sleeping, so a value already present costs no wall clock and a `timeoutMs` of
 * 0 still reads it.
 */
export async function pollFor<T>(read: () => T | undefined, options: PollOptions = {}): Promise<T | null> {
  const {
    timeoutMs = 5_000,
    pollIntervalMs = 5,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  } = options;

  const deadline = now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (now() >= deadline) return null;
    // Drain microtasks first - the un-awaited write usually settles here - then yield a macrotask.
    await new Promise<void>(resolve => setImmediate(resolve));
    await sleep(pollIntervalMs);
  }
}
