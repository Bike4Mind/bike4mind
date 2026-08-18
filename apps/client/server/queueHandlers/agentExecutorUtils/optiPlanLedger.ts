import type { IOptiPlanState } from '@bike4mind/database';

/**
 * Build the in-memory opti plan ledger for an invocation from the persisted execution field (#680).
 *
 * A plain-object copy so the guards can mutate it (increment `solved`, assign `steps`, flip
 * `decomposeUsed`) with `solved`/`results` copied so mutation doesn't alias the persisted doc.
 * (`BaseRepository.findById` already returns a plain object, so this is defensive, not required.)
 * Seeded ONLY from the persisted ledger -- never from an is-new-execution heuristic -- so a
 * legitimate first decompose that lands on a continuation isn't wrongly blocked. Note `solved`/
 * `results` can be absent on read (the schema's `minimize` drops empty maps), hence the `?? {}`.
 * Returns a fresh empty ledger when nothing is persisted yet.
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

/**
 * The ledger to write alongside a checkpoint, or `undefined` when there's nothing to persist (so a
 * non-opti run leaves the field untouched). Keeps the persist decision in one tested place rather
 * than duplicating the `optiPlanActive(...) ? state : undefined` ternary at each checkpoint site.
 */
export function ledgerForWrite(state: IOptiPlanState): IOptiPlanState | undefined {
  return optiPlanActive(state) ? state : undefined;
}
