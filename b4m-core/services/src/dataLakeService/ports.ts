/**
 * Best-effort retrieval/search index port. Removing a lake's documents on
 * archive/delete is best-effort - a failure is logged, not fatal - so a transiently
 * stale index entry is tolerated rather than blocking the lifecycle transition.
 * Optional: products without a separate index (vectors live in the chunk store) can
 * omit it entirely.
 */
export interface RetrievalIndexPort {
  removeByDataLakeTag(datalakeTag: string): Promise<void>;
}

/** Wrap a best-effort index removal so a failure never blocks the lifecycle op. */
export async function bestEffortIndexRemove(
  retrievalIndex: RetrievalIndexPort | undefined,
  datalakeTag: string,
  logger?: { warn: (msg: string, ...args: unknown[]) => void }
): Promise<void> {
  if (!retrievalIndex) return;
  try {
    await retrievalIndex.removeByDataLakeTag(datalakeTag);
  } catch (error) {
    logger?.warn(`Best-effort index removal failed for ${datalakeTag}:`, error);
  }
}
