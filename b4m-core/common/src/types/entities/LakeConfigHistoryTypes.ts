import type {
  ILakeConfigEventTarget,
  ILakeConfigFingerprintChange,
  ILakeConfigLeverChange,
  ILakeConfigLiteralChange,
  ILakeConfigTextFingerprint,
  LakeConfigChangeAction,
  LakeConfigChangePrincipalKind,
} from './LakeConfigChangeEventTypes';
import type { LakeManageRung } from './LakeConfigChangeEventTypes';
import type { LakeMembershipChangeOrigin } from './LakeMembershipChangeEventTypes';

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

/** Fields every History row has, whichever stream it came from. */
interface LakeConfigHistoryEntryBase {
  /** The event's own id - a stable React key, and the handle a per-event action (undo) uses. */
  eventId: string;
  changedAt: Date;
  principalKind: LakeConfigChangePrincipalKind;
  principalId: string;
  /** A user's display name or an API key's name, when still resolvable (a deleted key is not);
   * otherwise absent and the consumer falls back to the opaque `principalId`. Never an email - see
   * `userDisplayName`. */
  principalName?: string;
  onBehalfOfUserId?: string;
  onBehalfOfName?: string;
  /** The entity the row is about. Absent on old rows and on lake-level changes. */
  target?: ILakeConfigEventTarget;
  /** This row reverses that event. */
  undoesEventId?: string;
  /** Whether Undo applies: a supported action with the structured fields it needs, not yet undone. */
  undoable?: boolean;
  /** True once the event has been undone, whether or not the row that undid it is in this window. */
  undone?: boolean;
  /** The row that undid this one, when it is in the window. */
  undoneByEventId?: string;
  /** Why a row has no Undo button, when the reason is something the reader can act on. */
  undoNote?: string;
}

/**
 * One recorded config change, ready to render. Deliberately NOT aggregated per principal: a read is
 * an interchangeable repetition worth collapsing into a count, whereas each config change is a
 * distinct before -> after hop, and folding several into one row would destroy the chain an owner
 * reads the history FOR ("who moved it back?"). The access view (#1672) is expected to aggregate,
 * which is why this one states the choice explicitly.
 */
export interface LakeConfigHistoryConfigEntry extends LakeConfigHistoryEntryBase {
  kind: 'config';
  /** Which rung authorized the write - the field that makes a platform-admin edit visible AS SUCH. */
  manageRung: LakeManageRung;
  action: LakeConfigChangeAction;
  /** Only the fields that moved, in the producer's order. Never empty on a persisted event.
   *  Hash-free by type - see `LakeConfigHistoryFingerprint`. */
  changes: LakeConfigHistoryFieldChange[];
  /** Structured lever moves, with a feed address in its redacted form. Absent on old rows. */
  leverChanges?: ILakeConfigLeverChange[];
  /** The file an approve or auto-approve admitted. */
  admittedFabFileId?: string;
}

export const LAKE_CONFIG_HISTORY_FILE_ACTIONS = ['file-added', 'file-removed'] as const;
export type LakeConfigHistoryFileAction = (typeof LAKE_CONFIG_HISTORY_FILE_ACTIONS)[number];

/**
 * A file joining or leaving the lake, merged in from the membership log at read time. It has no
 * manage rung and no prose `changes`: the membership log records neither.
 */
export interface LakeConfigHistoryFileEntry extends LakeConfigHistoryEntryBase {
  kind: 'file';
  action: LakeConfigHistoryFileAction;
  target: ILakeConfigEventTarget;
  /**
   * The file's current name, present only while the file exists AND is still a member of the lake
   * (or is owned by the reader). Absent otherwise, where a reader falls back to the id.
   */
  fileName?: string;
  origin: LakeMembershipChangeOrigin;
  /** This row is a side effect of that event, so it has no Undo of its own. */
  causedByEventId?: string;
}

export type LakeConfigHistoryEntry = LakeConfigHistoryConfigEntry | LakeConfigHistoryFileEntry;

export interface LakeConfigHistoryView {
  lakeId: string;
  lakeName: string;
  /** Newest first across both streams, config events and file membership changes. */
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
  /**
   * Display names for the USER ids that appear as VALUES inside `entries[].changes` - the identity
   * fields (`effectiveOwnerUserId`, `createdByUserId`), whose before/after are raw ObjectIds.
   *
   * A map rather than resolved-in-place strings because the same id recurs across rows and the raw
   * id must stay available as the fallback: these rows are retained for years and outlive the
   * accounts they name, so an unresolvable id renders as itself rather than vanishing. Keyed by id,
   * value is the same never-an-email display name the principal columns use.
   *
   * Only user identities. `organizationId` and `preferredSystemPromptId` are ids too, but of other
   * entities entirely, and resolving them through a USER lookup would be wrong rather than merely
   * incomplete.
   */
  userNames: Record<string, string>;
}

/** What the undo route returns: the History row the undo wrote, plus anything the reader should know. */
export interface LakeConfigUndoResult {
  /** The undo's own History row, or null when that best-effort write did not persist. */
  entry: LakeConfigHistoryEntry | null;
  /** Consequences of the undo, in words (for example a schedule put on hold). */
  notes: string[];
}
