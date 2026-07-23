import type { IOptiPlanState } from '@bike4mind/database';

/**
 * Build the in-memory opti plan ledger for an invocation from the persisted execution field (#680).
 *
 * A plain-object DEEP-ish copy: the guards mutate this object in place (increment `solved`, assign
 * `steps`, flip `decomposeUsed`), so it must not be a live Mongoose subdocument, and `solved`/
 * `results` are copied so mutation doesn't alias the persisted doc. Seeded ONLY from the persisted
 * ledger -- never from `!isNewExecution` -- so a legitimate first decompose that lands on a
 * continuation isn't wrongly blocked. Returns a fresh empty ledger when nothing is persisted yet.
 */
export function rehydrateOptiPlanState(persisted: IOptiPlanState | null | undefined): IOptiPlanState {
  return {
    decomposeUsed: persisted?.decomposeUsed ?? false,
    steps: (persisted?.steps ?? []).map(s => ({ family: s.family, title: s.title })),
    solved: { ...(persisted?.solved ?? {}) },
    results: { ...(persisted?.results ?? {}) },
  };
}

/**
 * Whether the ledger holds anything worth persisting. Gates the checkpoint-ride writes so non-opti
 * runs (which never touch these fields) write no `optiPlanState`.
 */
export function optiPlanActive(state: Pick<IOptiPlanState, 'decomposeUsed' | 'steps'>): boolean {
  return state.decomposeUsed || state.steps.length > 0;
}
