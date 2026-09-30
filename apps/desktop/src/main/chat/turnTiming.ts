import type { ChatRoundTiming } from '@shared/chat';

/**
 * Times one request. `firstToken` is called for every streamed event that carries anything,
 * and only the first counts: a tool-only round still has a first token, which is the point.
 */
export function startRoundTimer(now: () => number = Date.now) {
  const startedAt = now();
  let firstTokenAt: number | undefined;
  return {
    firstToken(): void {
      firstTokenAt ??= now();
    },
    end(): ChatRoundTiming {
      return { startedAt, ...(firstTokenAt !== undefined ? { firstTokenAt } : {}), endedAt: now() };
    },
  };
}

/** What a sub-loop spent, summed over its rounds. Model and tool time are kept apart. */
export function createLoopTally() {
  let rounds = 0;
  let modelMs = 0;
  let toolMs = 0;
  return {
    async model<T>(run: () => Promise<T>, now: () => number = Date.now): Promise<T> {
      const started = now();
      try {
        return await run();
      } finally {
        rounds++;
        modelMs += now() - started;
      }
    },
    async tools<T>(run: () => Promise<T>, now: () => number = Date.now): Promise<T> {
      const started = now();
      try {
        return await run();
      } finally {
        toolMs += now() - started;
      }
    },
    summary: () => ({ rounds, modelMs, toolMs }),
  };
}
