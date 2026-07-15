/**
 * Durable workflow-state assembly from the in-memory stores.
 *
 * Decisions, blockers, and review gates are logged into their stores during a
 * live turn but only land on `session.metadata.workflow` when the session is
 * synced. Compaction (auto and reactive) reads `session.metadata.workflow`, so
 * without a flush it can copy a stale snapshot forward and drop state logged in
 * the current turn. These helpers are the single point of truth for turning the
 * three stores into a `WorkflowState`, so the save paths and the compaction
 * paths cannot drift on which fields land on the session.
 */
import type { Session, SessionHandoff, WorkflowState } from '../storage/types.js';

/** The three in-memory workflow stores, grouped for turn/compaction plumbing. */
export interface WorkflowStores {
  decisionStore: { decisions: WorkflowState['decisions'] };
  blockerStore: { blockers: WorkflowState['blockers'] };
  reviewGateStore: { reviewGates: NonNullable<WorkflowState['reviewGates']> };
}

/**
 * Assemble a `WorkflowState` from the in-memory stores, preserving an existing
 * handoff. Returns `undefined` when every store is empty so callers never write
 * a hollow workflow object onto session metadata.
 */
export function buildWorkflowState(
  stores: WorkflowStores,
  existingHandoff?: SessionHandoff
): WorkflowState | undefined {
  const { decisionStore, blockerStore, reviewGateStore } = stores;
  const hasState =
    decisionStore.decisions.length > 0 || blockerStore.blockers.length > 0 || reviewGateStore.reviewGates.length > 0;
  if (!hasState) return undefined;
  // Copy the arrays so session metadata never aliases the live mutable stores -
  // a later store push must not silently mutate an already-persisted snapshot.
  return {
    decisions: [...decisionStore.decisions],
    blockers: [...blockerStore.blockers],
    handoff: existingHandoff,
    reviewGates: [...reviewGateStore.reviewGates],
  };
}

/**
 * Return a copy of `session` with the current store state flushed onto
 * `metadata.workflow`, preserving any existing handoff. No-op (returns the same
 * reference) when the stores are empty. Immutable so the Zustand-held session is
 * never mutated in place.
 */
export function withFlushedWorkflowState(session: Session, stores: WorkflowStores): Session {
  const workflow = buildWorkflowState(stores, session.metadata.workflow?.handoff);
  if (!workflow) return session;
  return { ...session, metadata: { ...session.metadata, workflow } };
}
