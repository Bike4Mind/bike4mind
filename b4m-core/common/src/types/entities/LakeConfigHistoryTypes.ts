import type {
  ILakeConfigFieldChange,
  LakeConfigChangeAction,
  LakeConfigChangePrincipalKind,
} from './LakeConfigChangeEventTypes';
import type { LakeManageRung } from './LakeConfigChangeEventTypes';

// -- Lake Config History View ----------------------------------------------------------------
//
// The owner-facing read shape over LakeConfigChangeEventModel (#1769, PR 3): the first consumer of
// that collection's `listByLake`. Sits beside LakeAccessViewTypes (#1672) rather than inside it -
// this half answers "who CHANGED how the lake answers", the other "who READ it" - and both are
// rendered under the same manage gate in the owner access surface.

/**
 * One recorded config change, ready to render. Deliberately NOT aggregated per principal, which is
 * the one place this view departs from `aggregateAccessHistory`: a read is an interchangeable
 * repetition worth collapsing into a count, whereas each config change is a distinct
 * before -> after hop, and folding several into one row would destroy the chain an owner reads the
 * history FOR ("who moved it back?").
 */
export interface LakeConfigHistoryEntry {
  /** The event's own id - a stable React key, and the handle a future per-event drill-in would use. */
  eventId: string;
  changedAt: Date;
  principalKind: LakeConfigChangePrincipalKind;
  principalId: string;
  /** Resolved display name when the principal is a user AND still resolvable; otherwise absent and
   * the consumer falls back to the opaque `principalId`. Never an email - see `userDisplayName`. */
  principalName?: string;
  onBehalfOfUserId?: string;
  onBehalfOfName?: string;
  /** Which rung authorized the write - the field that makes a platform-admin edit visible AS SUCH. */
  manageRung: LakeManageRung;
  action: LakeConfigChangeAction;
  /** Only the fields that moved, in the producer's order. Never empty on a persisted event. */
  changes: ILakeConfigFieldChange[];
}

export interface LakeConfigHistoryView {
  lakeId: string;
  lakeName: string;
  /** Newest first, matching `listByLake`'s own sort. */
  entries: LakeConfigHistoryEntry[];
  /**
   * True when the read hit its cap, so `entries` is a WINDOW rather than the whole history. A
   * consumer must not render an empty-or-complete story off a truncated window.
   */
  truncated: boolean;
  /** The oldest event in the returned window, present only when `truncated` - lets a consumer say
   * "changes since <date>" instead of implying the list is all-time. */
  windowStartsAt?: Date;
  generatedAt: Date;
}
