import type { LocalUsage, LocalUsageFigures } from '@shared/usage';

/** A LocalUsage for tests: one model on this computer, with `totals` overridden as given. */
export function localUsageFixture(totals: Partial<LocalUsageFigures> = {}): LocalUsage {
  const figures: LocalUsageFigures = {
    replies: 0,
    outputTokens: 0,
    contextTokens: 0,
    timedReplies: 0,
    evalTokens: 0,
    evalMs: 0,
    estimatedReplies: 0,
    estimatedEvalTokens: 0,
    estimatedEvalMs: 0,
    promptTokens: 0,
    promptMs: 0,
    loads: 0,
    loadMs: 0,
    draftTokens: 0,
    draftAccepted: 0,
    ...totals,
  };
  const row = {
    replies: figures.replies,
    outputTokens: figures.outputTokens,
    evalTokens: figures.evalTokens,
    evalMs: figures.evalMs,
    estimatedEvalTokens: figures.estimatedEvalTokens,
    estimatedEvalMs: figures.estimatedEvalMs,
  };
  return {
    window: 'last-24-hours',
    granularity: 'hour',
    bars: [
      { startsAt: '2026-11-02T14:00:00.000Z', replies: 0, outputTokens: 0 },
      { startsAt: '2026-11-02T15:00:00.000Z', replies: figures.replies, outputTokens: figures.outputTokens },
    ],
    totals: figures,
    byModel: figures.replies ? [{ key: 'llama3.2', label: 'llama3.2', ...row }] : [],
    byServer: figures.replies ? [{ key: 'ollama', label: 'This computer', ...row }] : [],
    allTimeReplies: Math.max(figures.replies, 1),
    readAt: Date.parse('2026-11-02T15:20:00.000Z'),
  };
}
