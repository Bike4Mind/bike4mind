import type {
  ILakeConfigFingerprintChange,
  ILakeConfigLiteralChange,
  ILakeConfigTextFingerprint,
  LakeConfigChangeAction,
  LakeConfigChangePrincipalKind,
} from './LakeConfigChangeEventTypes';
import type { LakeManageRung } from './LakeConfigChangeEventTypes';

// -- Lake Config History View ----------------------------------------------------------------
//
// The owner-facing read shape over LakeConfigChangeEventModel (#1769, PR 3): the first consumer of
// that collection's `listByLake`. This half answers "who CHANGED how the lake answers"; the
// planned owner-facing access view (#1672) answers "who READ it". FORWARD REFERENCE: that view and
// its types do not exist yet, so nothing here imports them - the two are intended to render under
// the same manage gate once #1672 lands.

/**
 * A fingerprint as it goes ON THE WIRE: presence and size only, never the hash.
 *
 * `hash?: never` is the load-bearing part, not decoration. The stored fingerprint
 * (`ILakeConfigTextFingerprint`) carries a real truncated SHA-256 of the prompt, and structural
 * typing would happily accept that wider object wherever a narrower one is asked for - so merely
 * OMITTING the key would let `changes: event.changes` keep compiling while shipping the hash. The
 * optional-never makes that assignment a compile error, which is the only form of this rule that
 * cannot be undone by a later refactor.
 *
 * Why the hash must not leave the server at all: it is unsalted, so it is directly checkable
 * against a guessed prompt, and `listByLake` scopes only by `dataLakeId` - after
 * `transferLakeOwnership` a NEW owner reads rows written before they had any access to the lake.
 */
export type LakeConfigHistoryFingerprint = Omit<ILakeConfigTextFingerprint, 'hash'> & {
  hash?: never;
};

/** A fingerprinted field's move, hash-free. Mirrors `ILakeConfigFingerprintChange` otherwise. */
export interface LakeConfigHistoryFingerprintChange extends Omit<
  ILakeConfigFingerprintChange,
  'beforeFingerprint' | 'afterFingerprint'
> {
  beforeFingerprint: LakeConfigHistoryFingerprint;
  afterFingerprint: LakeConfigHistoryFingerprint;
  /**
   * Whether the two sides are the SAME text - the one question the hashes were being compared for
   * on the client, answered server-side so the hashes themselves need not travel.
   *
   * This is deliberately not the same disclosure: a hash is checkable against a guessed prompt and
   * correlates rows across owners, whereas this bit says only "these two versions of this one field
   * in this one edit matched", which is the audit's own stated purpose ("is this the same text as
   * some other version") and is what makes a whitespace-only save legible as `formatting only`
   * rather than as a misleading `replaced`.
   */
  textUnchanged: boolean;
}

/**
 * The wire twin of `ILakeConfigFieldChange`. The literal arm is shared verbatim - it carries only
 * values a reader is already entitled to see - and only the fingerprint arm is narrowed.
 */
export type LakeConfigHistoryFieldChange = ILakeConfigLiteralChange | LakeConfigHistoryFingerprintChange;

/**
 * One recorded config change, ready to render. Deliberately NOT aggregated per principal: a read is
 * an interchangeable repetition worth collapsing into a count, whereas each config change is a
 * distinct before -> after hop, and folding several into one row would destroy the chain an owner
 * reads the history FOR ("who moved it back?"). The access view (#1672) is expected to aggregate,
 * which is why this one states the choice explicitly.
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
  /** Only the fields that moved, in the producer's order. Never empty on a persisted event.
   *  Hash-free by type - see `LakeConfigHistoryFingerprint`. */
  changes: LakeConfigHistoryFieldChange[];
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
