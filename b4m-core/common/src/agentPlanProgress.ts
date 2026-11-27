/**
 * Step progress of an agent run that is working through a captured plan.
 *
 * The one place the "how many planned steps are done" rule lives: the executor's completion guard
 * (apps/workers planCompletionGuard.ts `planIsComplete`) and the public poll response
 * (`step_progress` on `GET /api/v1/agent-executions/{id}`) both read it, so a run the guard calls
 * finished always reports `completed === total`.
 *
 * Structural input, so this stays free of the database package: the persisted ledger is
 * `IOptiPlanState` (packages/database AgentExecutionModel.ts).
 */
export type PlanLedgerLike = {
  steps: ReadonlyArray<{ family: string }>;
  solved?: Readonly<Record<string, number>>;
};

export type PlanStepProgress = { completed: number; total: number };

/**
 * `completed` caps each family at its planned count, so re-solving one step never covers an
 * unsolved one. Null when no plan has loaded: a run without a plan has no knowable total.
 */
export function planStepProgress(ledger: PlanLedgerLike | null | undefined): PlanStepProgress | null {
  if (!ledger || ledger.steps.length === 0) return null;
  const needed: Record<string, number> = {};
  for (const step of ledger.steps) needed[step.family] = (needed[step.family] ?? 0) + 1;
  let completed = 0;
  for (const [family, count] of Object.entries(needed)) {
    completed += Math.min(ledger.solved?.[family] ?? 0, count);
  }
  return { completed, total: ledger.steps.length };
}
