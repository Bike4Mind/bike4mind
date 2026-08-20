import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import type { IDataLake } from './DataLakeTypes';
import { LAKE_ACCESS_PRINCIPAL_KINDS, type LakeAccessPrincipalKind } from './LakeAccessEventTypes';

// -- Lake Config Change Event ---------------------------------------------------------------
//
// The write-side twin of LakeAccessEventModel: one row per accepted CONFIG write, answering
// "who changed how this lake answers, what did they change it from and to, and which manage
// rung let them" (#1769). The read side records one turn; a config change alters every future
// answer for every reader of the lake, so the two want opposite retention - which is why this is
// a separate collection with its own lever rather than more fields on the access event. Types
// live here (not inline in the model) for the same reason as LakeAccessEventTypes: the services
// that record events cannot import @bike4mind/database.
//
// SCOPE: the event and its vocabulary. The owner-facing history that reads it is a later ticket;
// nothing surfaces these rows to a user yet.

/** Mirrors the read model's vocabulary deliberately (aliased, not re-declared, so the two can
 * never drift) - an audit reader learns one principal shape for both halves of the trail. */
export const LAKE_CONFIG_CHANGE_PRINCIPAL_KINDS = LAKE_ACCESS_PRINCIPAL_KINDS;
export type LakeConfigChangePrincipalKind = LakeAccessPrincipalKind;

/**
 * Which manage rung authorized the write, in `canManageLake`'s own ascending order. This is the
 * field that makes "a platform admin reconfigured a tenant's lake" visible AS SUCH rather than
 * inferable: every other rung belongs to someone with a standing relationship to the lake.
 *
 * `creator` and `grant-owner` are split even though `isEffectiveOwner` treats them as one, because
 * they answer different questions after a transfer: `creator` means the original author acting on
 * a lake that has never had an owner grant, `grant-owner` means whoever ownership was moved to.
 * `system` is for a write no principal drove (see the auto-activate action).
 *
 * MUST stay in sync with `resolveLakeManageRung` in b4m-core/services, which produces every rung
 * EXCEPT `system`. `system` comes from `recordLakeConfigChange` - either an explicit override (the
 * auto-activate path) or its fallback when no rung resolves - so grepping only the resolver will
 * not find where it originates.
 */
export const LAKE_MANAGE_RUNGS = [
  'platform-admin',
  'grant-owner',
  'creator',
  'grant-curator',
  'org-admin',
  'org-grant',
  'system',
] as const;
export type LakeManageRung = (typeof LAKE_MANAGE_RUNGS)[number];

/**
 * The operator action that produced the event, one per config-write service. Recorded alongside
 * the field diff because the diff alone is ambiguous: a `status` move to `archived` looks the same
 * whether an operator archived the lake or some future path wrote the field directly, and a
 * transfer moves no document field at all.
 */
export const LAKE_CONFIG_CHANGE_ACTIONS = [
  'update',
  'visibility',
  'transfer-ownership',
  'archive',
  'unarchive',
  'delete',
  'restore',
  /**
   * The phase-2 hard delete, recorded when the purge is ACCEPTED rather than when the sweep
   * finishes (#1744). Deliberately NOT folded into `delete`: that verb is the recoverable phase-1
   * soft delete, and an audit trail that cannot distinguish the reversible request from the
   * irreversible one is telling the same lie the `status` field used to.
   *
   * This is also the ONLY audit record a purge leaves. `cleanupDeletedDataLake` records nothing,
   * and it deletes the lake, its files, chunks, batches and grants - but never this collection, so
   * an accept-time event is what survives to say the operation was requested at all.
   */
  'purge',
  /**
   * The draft -> active flip driven by `activateIfDraft` (a tag edit, a file toggle, a batch
   * completion). Always records under the `system` RUNG, whoever triggered it: nothing authorized
   * it, because `activateIfDraft` runs no authorization check at all. The PRINCIPAL is a different
   * question - the tag doors know their operator and name them, while the batch doors do not and
   * record `system` for that too.
   */
  'auto-activate',
] as const;
export type LakeConfigChangeAction = (typeof LAKE_CONFIG_CHANGE_ACTIONS)[number];

/**
 * Every `IDataLake` field, classified as audited or not. A TOTAL map keyed by `keyof IDataLake`,
 * exactly like `LAKE_FIELD_VISIBILITY` in redactLakeForActor.ts and for the same reason: a list of
 * strings cannot notice an ABSENCE, so a new config field would simply never be audited and nobody
 * would find out. Keyed this way, a field added to the entity and classified nowhere is a COMPILE
 * error here, which is the only forcing function that actually works.
 *
 * `excluded` is for fields no operator chooses and which steer no answer: the content stats, the
 * teardown bookkeeping stamps, the cost meter and the lake-memory lease. They change constantly and
 * a history full of them would bury the changes that matter.
 */
export const LAKE_CONFIG_FIELD_AUDIT = {
  name: 'audited',
  slug: 'audited',
  description: 'audited',
  systemPrompt: 'audited',
  preferredSystemPromptId: 'audited',
  groundingMode: 'audited',
  requiredPassageTokenTarget: 'audited',
  fileTagPrefix: 'audited',
  datalakeTag: 'audited',
  requiredUserTag: 'audited',
  requiredEntitlement: 'audited',
  organizationId: 'audited',
  isPublic: 'audited',
  auditQueryTextEnabled: 'audited',
  status: 'audited',
  // Immutable by design (it anchors the membership prefix arm), so this is a tripwire rather than
  // an expected row: if it ever moves, the audit says so instead of the change passing unseen.
  createdByUserId: 'audited',
  // The actor stamp is the WHO of the very write being recorded - the event already carries it as
  // `principalId`, so auditing it too would put a redundant row in every single change.
  lastUpdatedByUserId: 'excluded',
  fileCount: 'excluded',
  totalSizeBytes: 'excluded',
  totalChunkedChars: 'excluded',
  embeddingSpendMicroUsd: 'excluded',
  lastSyncAt: 'excluded',
  filesDeletedAt: 'excluded',
  filesArchivedAt: 'excluded',
  lakeMemoryExtractionAt: 'excluded',
  lakeMemoryCursor: 'excluded',
} as const satisfies Record<keyof IDataLake, 'audited' | 'excluded'>;

/** The audited keys as a precise literal union, derived from the map so the two cannot drift. */
export type LakeConfigDocumentField = {
  [K in keyof typeof LAKE_CONFIG_FIELD_AUDIT]: (typeof LAKE_CONFIG_FIELD_AUDIT)[K] extends 'audited' ? K : never;
}[keyof typeof LAKE_CONFIG_FIELD_AUDIT];

/**
 * The runtime list the differ iterates and the schema enumerates, DERIVED from the map above so
 * there is exactly one source of truth. Key order is insertion order, which only affects the order
 * changes appear within one event.
 */
export const LAKE_CONFIG_DOCUMENT_FIELDS = (
  Object.keys(LAKE_CONFIG_FIELD_AUDIT) as (keyof typeof LAKE_CONFIG_FIELD_AUDIT)[]
).filter(field => LAKE_CONFIG_FIELD_AUDIT[field] === 'audited') as readonly LakeConfigDocumentField[];

/**
 * Fields stored as a bounded FINGERPRINT (presence, length, hash) instead of a literal
 * before/after. The test is not "is this a string" but "is this uncapped free text an editor
 * writes": `systemPrompt` is uncapped by both its schema and its request validator, and it is
 * withheld from readers precisely because it steers every answer the lake gives, so a verbatim
 * before AND after on every edit would turn this collection into a second, longer-lived copy of
 * the most sensitive editor-only field on the lake.
 *
 * `description` is deliberately NOT here: it is capped at 2000 chars by the request schema and is
 * already reader-visible (see READER_LAKE_FIELDS), so storing it literally leaks nothing that is
 * not already served, and its literal value is what makes the history readable.
 */
export const LAKE_CONFIG_FINGERPRINTED_FIELDS = ['systemPrompt'] as const satisfies readonly (keyof IDataLake)[];

/**
 * A DERIVED field, not a document one: ownership lives in `DataLakeAccessGrant` rows, so a
 * transfer moves nothing on the lake itself. Recording it as an ordinary field change keeps the
 * history one uniform "field: before -> after" list instead of a special case per action.
 */
export const LAKE_CONFIG_DERIVED_FIELD_EFFECTIVE_OWNER = 'effectiveOwnerUserId';

export const LAKE_CONFIG_CHANGE_FIELDS: readonly LakeConfigChangeField[] = [
  ...LAKE_CONFIG_DOCUMENT_FIELDS,
  LAKE_CONFIG_DERIVED_FIELD_EFFECTIVE_OWNER,
];
export type LakeConfigChangeField = LakeConfigDocumentField | typeof LAKE_CONFIG_DERIVED_FIELD_EFFECTIVE_OWNER;

/**
 * Compile-time pin: every field `UpdateDataLakeRequestInput` can write MUST be audited. Without it
 * a new settable field would land unaudited and its edits would be invisible in the history. The
 * assertion lives here rather than in the schema package because this is the list that has to grow.
 * (It no longer also gates the WRITE - see the raw-equality no-op test in updateDataLake.)
 */
export type LakeConfigAuditCoversEveryUpdatableField<TUpdatableField extends LakeConfigChangeField> = TUpdatableField;

/**
 * The scalar shapes a bounded field's before/after can take. An ABSENT key means the field was
 * unset on that side - which is also how the diff records a clear, because the config surface has
 * three spellings of "not set" (`undefined`, `null`, `''`) that mean the same thing to every read
 * path, and a history that distinguished them would report a change on a PUT that cleared an
 * already-clear gate. `null` stays in the union because the collection can hold one from a
 * hand-written row; `diffLakeConfig` never produces it.
 */
export type LakeConfigLiteralValue = string | number | boolean | null;

export const LAKE_CONFIG_CHANGE_VALUE_KINDS = ['literal', 'fingerprint'] as const;
export type LakeConfigChangeValueKind = (typeof LAKE_CONFIG_CHANGE_VALUE_KINDS)[number];

/**
 * A LONG free-text field described without reproducing it. `systemPrompt` is uncapped and is the
 * single most sensitive editor-only field on a lake; copying its before AND after into an audit
 * row on every edit would make this collection a second, longer-lived copy of it. The fingerprint
 * answers what an audit actually needs - did it exist, how big was it, is this the same text as
 * some other version - without ever being the text. Same identifiers-not-payload line the read
 * side draws for chunk text.
 */
export interface ILakeConfigTextFingerprint {
  /** False for unset/null/blank (whitespace-only counts as blank, matching redactLakeForActor). */
  present: boolean;
  /** Unicode CODE POINTS, not UTF-16 units, so the number means the same thing for every script. */
  length: number;
  /** Truncated SHA-256 hex of the trimmed text; empty string when `present` is false. Equality
   * across two events means the same prompt, which is what makes a revert legible. */
  hash: string;
}

/**
 * A bounded field's move. `before`/`after` stay optional because an ABSENT key means "unset on
 * that side" - that is how a set and a clear are both legible without a sentinel value.
 */
export interface ILakeConfigLiteralChange {
  field: LakeConfigChangeField;
  kind: 'literal';
  before?: LakeConfigLiteralValue;
  after?: LakeConfigLiteralValue;
  /** True when a string value was capped at LAKE_CONFIG_VALUE_MAX_CHARS, so a reader can tell a
   * stored-and-complete value from a stored-and-clipped one rather than guessing. */
  truncated?: boolean;
}

/**
 * A long free-text field's move, described without reproducing it. Both fingerprints are REQUIRED:
 * a fingerprint is computable for an absent value too (`present: false`), so there is no state
 * where one side is unknown - which is what lets a consumer render the row without a null check.
 */
export interface ILakeConfigFingerprintChange {
  field: LakeConfigChangeField;
  kind: 'fingerprint';
  beforeFingerprint: ILakeConfigTextFingerprint;
  afterFingerprint: ILakeConfigTextFingerprint;
}

/**
 * A REAL discriminated union, not one object with four optional keys: narrowing on `kind` has to
 * actually give a consumer the fields that arm carries, or the discriminant buys nothing and the
 * history UI ends up writing non-null assertions for states the producer can never emit.
 * The kind is a property of the FIELD (see LAKE_CONFIG_FINGERPRINTED_FIELDS), not of the values.
 */
export type ILakeConfigFieldChange = ILakeConfigLiteralChange | ILakeConfigFingerprintChange;

export interface ILakeConfigChangeEvent {
  principalKind: LakeConfigChangePrincipalKind;
  principalId: string;
  /**
   * Set when a system/agent principal acted for a human, so the human stays findable.
   *
   * RESERVED, and never populated today - by anything, on either audit model. The read side
   * (`ILakeAccessEvent`) declares and persists the identical field and has no producer for it
   * either; the vocabulary is mirrored deliberately so the two collections cannot drift, and
   * dropping it here alone would break that parity without fixing the read side. `ManageActor`
   * carries no on-behalf-of identity to thread, so populating it is a change to the actor
   * contract, not to this model.
   *
   * The consequence to know when PR 3 renders these rows: this field is `undefined` on every
   * event written today, so a history view must not give it a column of its own yet.
   */
  onBehalfOfUserId?: string;
  /**
   * The LAKE's org scope at the time of the write, not the actor's - it is what an org-wide
   * "show me every config change on our lakes" query filters on, and the actor's own org is
   * recoverable from their user record. Absent for a personal (org-less) lake. When the write
   * MOVED the scope, the before/after is in `changes` under `organizationId`; this field holds
   * the value the lake carried going in.
   */
  organizationId?: string;
  /** Single lake, unlike the read event's `resolvedLakeIds`: a config write always names one. */
  dataLakeId: string;
  manageRung: LakeManageRung;
  action: LakeConfigChangeAction;
  /**
   * Only the fields that actually MOVED. Never empty on a persisted event: a write that changed
   * nothing records nothing at all (see recordLakeConfigChange).
   *
   * A caveat worth knowing before reading a history as complete: a config write only produces an
   * event where the audit repository is WIRED. The seven config-write services require it (their
   * adapters make it non-optional, so a route cannot forget it), but `recomputeLakeStats` - which
   * emits `auto-activate` - takes it optionally because it has many callers, and the ones outside
   * the lake/file/batch doors record nothing. So an empty history means "no recorded change",
   * which for the config surface is the same thing and for auto-activate is not quite.
   */
  changes: ILakeConfigFieldChange[];
  /** Computed at write time from the floor-clamped retention; TTL-indexed. */
  expiresAt: Date;
}

export interface ILakeConfigChangeEventDocument extends ILakeConfigChangeEvent, IMongoDocument {}

export interface RecordLakeConfigChangeInput {
  principalKind: LakeConfigChangePrincipalKind;
  principalId: string;
  /** Reserved; no producer sets it today - see the note on `ILakeConfigChangeEvent`. */
  onBehalfOfUserId?: string;
  organizationId?: string;
  dataLakeId: string;
  manageRung: LakeManageRung;
  action: LakeConfigChangeAction;
  changes: ILakeConfigFieldChange[];
  /** The platform-configured retention (days), if the caller resolved it; unconditionally clamped
   * to the floor inside `record()` regardless of what is passed here. */
  retentionDays?: number;
}

/**
 * Read/append only by construction: no update or delete is exposed, matching the access event's
 * repository. An audit row is a claim about something that already happened - editing one is never
 * a legitimate operation, so the capability simply does not exist here.
 */
export interface ILakeConfigChangeEventRepository extends Pick<
  IBaseRepository<ILakeConfigChangeEventDocument>,
  'find' | 'findOne' | 'findById' | 'count'
> {
  record(input: RecordLakeConfigChangeInput): Promise<ILakeConfigChangeEventDocument>;
  /** Newest first, tie-broken on `_id`: a TOTAL order, so repeated calls agree and a `limit`
   * window is reproducible. A history surface exists to say what happened in what sequence. */
  listByLake(lakeId: string, opts?: { limit?: number }): Promise<ILakeConfigChangeEventDocument[]>;
}

type AssertTrue<T extends true> = T;

/**
 * COMPILE-TIME GUARD on the append-only shape above: widening this interface (to `IBaseRepository`,
 * say) would hand every caller `update`/`delete` on an audit collection, and the concrete class DOES
 * inherit both from BaseRepository at runtime - the narrow type is the only thing withholding them.
 *
 * Asserted HERE rather than in a test: the packages exclude test files from tsconfig and vitest
 * transpiles without typechecking, so a `@ts-expect-error` inside a spec is never evaluated by
 * anything. A type-level assertion in a real source file is; adding a method to the interface
 * without adding it to this list fails the build.
 */
export type LakeConfigChangeEventRepositoryIsAppendOnly = AssertTrue<
  Exclude<
    keyof ILakeConfigChangeEventRepository,
    'record' | 'listByLake' | 'find' | 'findOne' | 'findById' | 'count'
  > extends never
    ? true
    : false
>;
