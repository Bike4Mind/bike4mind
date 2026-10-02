import type {
  DataLakeAccessRole,
  DataLakePrincipalType,
  IDataLake,
  IDataLakeBatch,
  ILakeConfigFieldChange,
  ILakeConfigLiteralChange,
  LakeConfigChangeField,
  LakeConfigLiteralValue,
} from '@bike4mind/common';
import {
  LAKE_CONFIG_DOCUMENT_FIELDS,
  LAKE_CONFIG_FINGERPRINTED_FIELDS,
  capLakeConfigValue,
  lakeConfigTextFingerprint,
} from '@bike4mind/common';

/** The audited fields whose stored value is a boolean. Their absent form is `false` (every read
 * path defaults them off), so a write of `false` onto a never-set field is not a change. */
const BOOLEAN_FIELDS = new Set<LakeConfigChangeField>([
  'isPublic',
  'auditQueryTextEnabled',
  'lakeMemoryEnabled',
  'injectPromptForReaders',
]);

const FINGERPRINTED = new Set<LakeConfigChangeField>(LAKE_CONFIG_FINGERPRINTED_FIELDS);

/** The two access-gate fields, whose "unset" must match `lakeMatchesAccess`'s raw truthiness rather
 * than a trim - see normalizeValue. */
const GATE_FIELDS = new Set<LakeConfigChangeField>(['requiredUserTag', 'requiredEntitlement']);

/**
 * The canonical value of one audited field, or `undefined` for "not set".
 *
 * `undefined` (never written), `null` (the clear sentinel on `requiredPassageTokenTarget` and
 * `organizationId`) and `''` all collapse to `undefined`, so clearing an already-clear field does
 * not record a change that made no difference to a single answer the lake gives.
 *
 * THE GATE FIELDS ARE THE EXCEPTION, and the reason is that the access gate does not trim. The
 * predicate every read path actually runs is `lakeMatchesAccess`
 * (`common/src/constants/dataLakes.ts`), whose test is raw truthiness:
 * `!!lake.requiredUserTag || !!lake.requiredEntitlement`. `!!' '` is `true`, so a whitespace-only
 * tag is a LIVE gate that no user can satisfy, while `''` is no gate at all - opposite behaviours,
 * not two spellings of the same one. Trimming them together made the audit blind to the single
 * most important write on this surface: clearing a stuck whitespace gate emitted
 * `before=undefined, after=undefined` and recorded nothing. So for those two fields only, "unset"
 * means exactly what the gate means by it.
 */
function normalizeValue(field: LakeConfigChangeField, raw: unknown): LakeConfigLiteralValue | undefined {
  if (BOOLEAN_FIELDS.has(field)) return !!raw;
  if (raw === undefined || raw === null) return undefined;
  // Gate fields keep whitespace, matching lakeMatchesAccess's truthiness - see the note above.
  if (typeof raw === 'string' && GATE_FIELDS.has(field)) return raw === '' ? undefined : raw;
  if (typeof raw === 'string') return raw.trim() === '' ? undefined : raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'boolean') return raw;
  // A Date or an ObjectId reaching here would mean a non-scalar field joined the audited list;
  // stringify rather than store a shape the schema cannot represent.
  return String(raw);
}

/** Emits `before`/`after` only for the sides that are SET, so an absent key reads as "unset" and a
 * cleared field is legible without a sentinel value. */
function literalChange(
  field: LakeConfigChangeField,
  before: LakeConfigLiteralValue | undefined,
  after: LakeConfigLiteralValue | undefined
): ILakeConfigLiteralChange {
  const change: ILakeConfigLiteralChange = { field, kind: 'literal' };
  let truncated = false;
  if (before !== undefined) {
    const capped = typeof before === 'string' ? capLakeConfigValue(before) : { value: before, truncated: false };
    change.before = capped.value;
    truncated = truncated || capped.truncated;
  }
  if (after !== undefined) {
    const capped = typeof after === 'string' ? capLakeConfigValue(after) : { value: after, truncated: false };
    change.after = capped.value;
    truncated = truncated || capped.truncated;
  }
  if (truncated) change.truncated = true;
  return change;
}

/**
 * The pure before/after comparison behind every config-change event: given the lake document as it
 * stood and as it now stands, emit one entry per field that ACTUALLY MOVED, and nothing for a
 * write that changed no value.
 *
 * That "nothing" is the whole point of computing a diff rather than trusting the write. A write can
 * land without moving a single audited value - a re-save that only reformats whitespace, or one
 * that flips a field this list excludes - and recording it as a config CHANGE would put a line in
 * an owner's history for something that never altered how their lake answers.
 *
 * This is deliberately NOT the test for whether the write itself should happen. `updateDataLake`
 * decides that by raw equality against the values the caller supplied, because the normalization
 * below (three spellings of unset onto one value, trimmed free text) is right for a history and
 * wrong for a write gate - it would make a whitespace-only value impossible to clear.
 *
 * Long free-text fields (LAKE_CONFIG_FINGERPRINTED_FIELDS - today just `systemPrompt`) are compared
 * and stored as bounded fingerprints, never verbatim: an audit needs to know a prompt changed, how
 * big it was, and whether a later edit restored it, none of which requires a second copy of the
 * most sensitive editor-only field on the lake.
 */
export function diffLakeConfig(before: Partial<IDataLake>, after: Partial<IDataLake>): ILakeConfigFieldChange[] {
  const changes: ILakeConfigFieldChange[] = [];

  for (const field of LAKE_CONFIG_DOCUMENT_FIELDS) {
    if (FINGERPRINTED.has(field)) {
      const beforeFingerprint = lakeConfigTextFingerprint(before[field] as string | null | undefined);
      const afterFingerprint = lakeConfigTextFingerprint(after[field] as string | null | undefined);
      // Hash equality is the change test; `present` is compared too so unset -> blank-but-present
      // cannot slip through on two empty hashes (it also cannot today - a blank fingerprints as
      // absent - but the pair is what the reader renders, so compare what is stored).
      if (beforeFingerprint.hash === afterFingerprint.hash && beforeFingerprint.present === afterFingerprint.present) {
        continue;
      }
      changes.push({ field, kind: 'fingerprint', beforeFingerprint, afterFingerprint });
      continue;
    }

    const beforeValue = normalizeValue(field, before[field]);
    const afterValue = normalizeValue(field, after[field]);
    if (beforeValue === afterValue) continue;
    changes.push(literalChange(field, beforeValue, afterValue));
  }

  return changes;
}

/**
 * The ownership change, which no document field carries: ownership lives in access-grant rows, so
 * `diffLakeConfig` can never see it. Emitted as an ordinary field entry on the derived
 * `effectiveOwnerUserId` field so a history renders one uniform list rather than a special case.
 *
 * Prior owners are joined rather than listed because the value shape is scalar and the set is
 * almost always a single id; the join is capped like any other literal.
 *
 * Returns `null` when ownership did not actually move - transferring a lake to the person who
 * already solely owns it is a legitimate, accepted request that demotes nobody, and it is NOT a
 * change event, for exactly the same reason a same-value PUT is not.
 */
export function ownershipChange(
  priorOwnerUserIds: readonly string[],
  newOwnerUserId: string
): ILakeConfigLiteralChange | null {
  const before = priorOwnerUserIds.filter(Boolean).join(',');
  if (before === newOwnerUserId) return null;
  return literalChange('effectiveOwnerUserId', before === '' ? undefined : before, newOwnerUserId);
}

/**
 * One grant write, as a change entry. Grants live in `DataLakeAccessGrant` rows, so - exactly like
 * `ownershipChange` above - `diffLakeConfig` can never see this and it is synthesized onto the
 * derived `accessGrant` field.
 *
 * The PRINCIPAL is encoded into both sides (`"user:<id>=reader"`) rather than carried separately,
 * because the field's before/after pair is the only shape the history renders and "who" is the
 * entire content of an access change - a bare `reader -> undefined` names no one. A revoke leaves
 * the after side unset, which is how the differ already spells "cleared".
 *
 * THE EXPIRY IS PART OF THE VALUE, not a separate field, because it is part of what the grant
 * confers: shortening a reader grant to lapse tomorrow, or lifting the expiry off one so it never
 * does, changes a principal's access exactly as much as a re-role does. Encoded only when set, so an
 * ordinary open-ended grant still reads as the bare `user:<id>=reader` it always did.
 *
 * Returns `null` when neither the role NOR the expiry moved: re-granting a principal the role they
 * already hold on the terms they already hold it is an accepted, idempotent request that changed
 * nothing - the same rule `ownershipChange` applies to a transfer to the current owner.
 */
export function grantChange(
  principalType: DataLakePrincipalType,
  principalId: string,
  before: DataLakeAccessRole | undefined,
  after: DataLakeAccessRole | undefined,
  beforeExpiresAt?: Date | null,
  afterExpiresAt?: Date | null
): ILakeConfigLiteralChange | null {
  const encode = (role: DataLakeAccessRole | undefined, expiresAt: Date | null | undefined) => {
    if (role === undefined) return undefined;
    const grant = `${principalType}:${principalId}=${role}`;
    return expiresAt ? `${grant} until ${expiresAt.toISOString()}` : grant;
  };
  const beforeValue = encode(before, beforeExpiresAt);
  const afterValue = encode(after, afterExpiresAt);
  if (beforeValue === afterValue) return null;
  return literalChange('accessGrant', beforeValue, afterValue);
}

/**
 * One proposal-review decision, as a change entry. The reviewed row lives in `DataLakeProposal`, so
 * - exactly like `grantChange` above - `diffLakeConfig` can never see this and it is synthesized
 * onto the derived `proposalReview` field.
 *
 * The proposal is encoded into the value rather than carried separately, for the same reason
 * `grantChange` bakes the principal into its string: the action (`approve-proposal` /
 * `decline-proposal` / `restore-proposal`) already says WHAT happened, so the value only needs to
 * say WHICH queued source it happened to. The title leads because it is what the review queue
 * shows a curator; the source url follows because it is the only identifier - two proposals titled
 * "Home" are otherwise indistinguishable, and the row is permanent. A blank title records the url
 * alone. `before` is always unset - see LAKE_CONFIG_EVENT_VALUE_FIELDS.
 */
export function proposalReviewChange(
  proposal: { title?: string; sourceUrl: string },
  decision: 'approved' | 'declined' | 'restored'
): ILakeConfigLiteralChange {
  const title = proposal.title?.trim();
  const label = title ? `${title} (${proposal.sourceUrl})` : proposal.sourceUrl;
  return literalChange('proposalReview', undefined, `${decision}: ${label}`);
}

/**
 * A saved research configuration's create/update/delete, as a change entry - the same
 * derived-field, value-encoded pattern as `proposalReviewChange` above, since a config lives in its
 * own collection and never on the lake document. The NAME is what a curator recognizes a config by
 * in the list, so it is the identifier encoded here rather than the (longer, less scannable) query.
 */
export function researchConfigChange(
  configName: string,
  decision: 'created' | 'updated' | 'deleted'
): ILakeConfigLiteralChange {
  return literalChange('researchConfig', undefined, `${decision}: ${configName}`);
}

/**
 * A research run reaching a lifecycle point (started, then completed or failed), as a change entry
 * - same pattern again. Encodes the run's own QUERY, not the config's name: the background
 * executor that records the outcome half (`recordResearchRunOutcome`, called from
 * `runLakeResearch.ts`) only ever has the run's levers snapshot to work from, never the config
 * document - using the same identifier here is what lets a reader match a `start-research-run` row
 * to the `complete-research-run` row it belongs to. A failure's reason lives on the run row's own
 * `error` field, not here.
 *
 * The RUN ID is also encoded, because the query alone is not: a config run twice with no edit
 * between produces two `started: <query>` rows with nothing to tell them apart, and their matching
 * `completed`/`failed` rows the same way - a reader (or a script) trying to pair a start to its
 * outcome by query text alone cannot tell which pairs with which.
 */
export function researchRunChange(
  query: string,
  outcome: 'started' | 'completed' | 'failed',
  runId: string
): ILakeConfigLiteralChange {
  return literalChange('researchRun', undefined, `${outcome}: ${query} (run ${runId})`);
}

/**
/**
 * How an upload batch was settled. `finished` is the normal finalize; `cancelled` is the uploader's
 * cancel; `stopped` is the stuck-batch reconciler forcing an abandoned batch terminal.
 */
export type UploadBatchOutcome = 'finished' | 'cancelled' | 'stopped';

const UPLOAD_OUTCOME_PREFIX: Record<UploadBatchOutcome, string> = {
  finished: '',
  cancelled: 'Upload cancelled: ',
  stopped: 'Upload stopped: ',
};

/**
 * A settled upload batch, as a change entry - the same derived-field, value-encoded pattern as the
 * research helpers above, since a batch lives in its own collection. Counts only the files that
 * landed, plus the ones that did not, so "12 files" never hides 3 that failed. A cancelled or
 * stopped batch says so up front: its counts are what had landed when it settled, and a lake that
 * went Draft -> Published off an abandoned upload should not look like it got a clean one.
 */
export function uploadBatchChange(
  batch: Pick<IDataLakeBatch, 'vectorizedFiles' | 'failedFiles' | 'skippedFiles' | 'deferredFiles'>,
  outcome: UploadBatchOutcome = 'finished'
): ILakeConfigLiteralChange {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const extras = [
    batch.failedFiles > 0 ? `${batch.failedFiles} failed` : '',
    batch.skippedFiles > 0 ? `${batch.skippedFiles} skipped` : '',
    (batch.deferredFiles ?? 0) > 0 ? `${batch.deferredFiles} not finished` : '',
  ].filter(Boolean);
  const summary = `${UPLOAD_OUTCOME_PREFIX[outcome]}${count(batch.vectorizedFiles, 'file')} added${extras.length ? ` (${extras.join(', ')})` : ''}`;
  return literalChange('upload', undefined, summary);
}
