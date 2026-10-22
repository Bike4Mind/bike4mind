/**
 * Fire-and-forget persistence of in-flight agent steps for processExecution.
 *
 * Each write runs off the iteration loop so a slow DB write never stalls it, but the
 * invocation must `drain()` before it returns: Lambda freezes the container once the
 * handler resolves, and a write (or its failure metric) still in flight is then lost, or
 * its PutMetricData is sent on a later thaw past the SigV4 signature window.
 *
 * Kept in its own module, with structural deps, so it can be unit-tested without the
 * executor's Mongo/AWS/SST imports (same pattern as agentExecutor.checkpointDepth.ts).
 */

export interface InflightStepPersisterDeps<TStep> {
  executionId: string;
  persistSteps: (executionId: string, steps: TStep[]) => Promise<unknown>;
  logger: { warn(message: string, metadata?: Record<string, unknown>): void };
  emitMetric: (namespace: string, metricName: string, value: number) => Promise<void>;
}

export interface InflightStepPersister<TStep> {
  /** Starts a write without waiting for it; failures are logged and counted, never thrown. */
  persist(steps: TStep[]): void;
  /** Resolves once every write started so far, and its failure metric, has settled. */
  drain(): Promise<void>;
}

export function createInflightStepPersister<TStep>(
  deps: InflightStepPersisterDeps<TStep>
): InflightStepPersister<TStep> {
  const { executionId, persistSteps, logger, emitMetric } = deps;
  const pending = new Set<Promise<void>>();

  const writeSteps = async (steps: TStep[]): Promise<void> => {
    try {
      await persistSteps(executionId, steps);
    } catch (err) {
      logger.warn('[Stream] Failed to persist in-flight steps', {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await emitMetric('Lumina5/AgentExecutor', 'InflightStepsPersistFailed', 1);
    }
  };

  return {
    persist(steps) {
      const write = writeSteps(steps);
      pending.add(write);
      const forget = () => {
        pending.delete(write);
      };
      void write.then(forget, forget);
    },
    async drain() {
      await Promise.allSettled([...pending]);
    },
  };
}
