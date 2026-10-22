import type {
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeProposalDocument,
  IDataLakeProposalRepository,
  IDataLakeRepository,
} from '@bike4mind/common';
import {
  BadGatewayError,
  DATALAKE_TAG_STRENGTH,
  FabFileSourceType,
  GatewayTimeoutError,
  isLakeIngestable,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, HTTPError, NotFoundError } from '@bike4mind/utils';
import { assertLakeWritable } from './assertLakeAccess';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { proposalReviewChange } from './diffLakeConfig';
import { canManageLake, type LakeGrant, type ManageActor, type SerializeLakeClaim } from './manageRule';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';

/**
 * The human half of the acquisition queue (#1671): approve or decline one proposal.
 *
 * Approval is the ONLY way a proposal's content reaches a lake, and it reaches it through the
 * ordinary ingestion door - the caller supplies `admitSource`, bound to the same
 * `createFabFileByUrl` path the Slack link door uses, so an approved proposal is chunked at the
 * applicable policy like any other member. There is deliberately no bypass that writes a FabFile
 * from the proposal's stored excerpt: admitting content through a side door would recreate the exact
 * defect this epic exists to fix.
 *
 * There is no auto-approval entry point here, and none may be added (#1658 decision 10). Both
 * functions take an ACTOR resolved from auth and stamp it on the row.
 */

/** Bound by the caller to `fabFilesService.createFabFileByUrl` + its storage/db adapters. */
export interface AdmitSourceParams {
  url: string;
  tags: Array<{ name: string; strength: number }>;
  provenance: { sourceType: FabFileSourceType; sourceMetadata: Record<string, unknown> };
}

export type AdmittedFile = { id: string; fileName: string };

export interface ReviewAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    dataLakeProposals: Pick<
      IDataLakeProposalRepository,
      'findById' | 'claimForReview' | 'recordAdmission' | 'releaseClaim'
    >;
    dataLakes: Pick<IDataLakeRepository, 'findById'>;
    // Optional for the same reason as everywhere else in this family: absent, manage falls back to
    // createdByUserId + the org-admin rung (see loadActiveLakeGrants).
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    // REQUIRED, not optional: every caller of this service is the one review route, so leaving it
    // optional would let a review decision go unaudited silently.
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
  };
  /**
   * Takes the whole ACTOR, not just its id. The admission door runs its own lake-tag write gate, and
   * that gate needs the same principal the review gate above resolved - `administeredOrgIds` in
   * particular cannot be recovered from a userId. Passing only the id made the write gate strictly
   * narrower than the review gate, so a curator or org admin cleared the 403, had the row claimed,
   * and was then refused the admission with nothing retryable.
   */
  admitSource(actor: ManageActor, params: AdmitSourceParams): Promise<AdmittedFile>;
  /**
   * Wraps the gate and the claim; the admission runs after it returns, since a network fetch cannot
   * sit inside a transaction a retry would repeat. REQUIRED so the claim is never silently
   * unserialized.
   */
  serializeClaim: SerializeLakeClaim;
}

type ReviewableAdapters = Omit<ReviewAdapters, 'admitSource' | 'serializeClaim'>;

interface ResolveReviewableAdapters {
  db: {
    dataLakeProposals: Pick<IDataLakeProposalRepository, 'findById'>;
    dataLakes: Pick<IDataLakeRepository, 'findById'>;
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  };
}

/**
 * Resolve the proposal and its lake, and assert the caller may rule on it. Not-found for a missing
 * proposal or a vanished lake; manage-denied for a caller without write authority over the lake,
 * mirroring `removeFileFromLake`. Reviewing is a lake-management right, not a lake-read one: anyone
 * who can read a lake must not be able to decide what enters it.
 *
 * Returns the ACTIVE GRANTS alongside the gate's own verdict (rather than re-fetching them for the
 * audit call below), for the same reason `updateDataLake` loads them once: the gate and the
 * recorded manage rung must agree on the same grant set, and a second fetch could see a grant
 * revoked microseconds later and report a rung that did not in fact authorize this write.
 */
async function resolveReviewable(
  proposalId: string,
  actor: ManageActor,
  { db }: ResolveReviewableAdapters
): Promise<{ proposal: IDataLakeProposalDocument; lake: IDataLakeDocument; grants: LakeGrant[] }> {
  const proposal = await db.dataLakeProposals.findById(proposalId);
  if (!proposal) throw new NotFoundError('Proposal not found');

  const lake = await db.dataLakes.findById(proposal.dataLakeId);
  if (!lake) throw new NotFoundError('Proposal not found');

  const grants = await loadActiveLakeGrants(lake, { db });
  // 403, matching the sibling manage-gated read (`data-lakes/[id]/spend.ts`): the lake read gate
  // above has already cleared the caller, so refusing here is an authorization answer, not a
  // malformed request. Any change to this status belongs in the list route too.
  if (!canManageLake(lake, actor, grants)) {
    throw new ForbiddenError('You do not have permission to review proposals for this data lake');
  }
  return { proposal, lake, grants };
}

/**
 * A timeout of the SOURCE fetch: axios's timeout codes, plus the redirect-chain deadline
 * `fetchAndParseURL` throws itself. Gated on `isAxiosError` so a storage-upload `ETIMEDOUT`, which
 * happens after the row is written, is never retried as if nothing had been created.
 */
function isSourceTimeout(err: unknown): boolean {
  const { code, message, isAxiosError } = (err ?? {}) as { code?: string; message?: string; isAxiosError?: boolean };
  if (isAxiosError && (code === 'ECONNABORTED' || code === 'ETIMEDOUT')) return true;
  return typeof message === 'string' && /^timeout of \d+ms exceeded|^Timed out while following redirects/.test(message);
}

const SOURCE_NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']);

/**
 * Turn an admission failure into something the REVIEWER can act on.
 *
 * The ingestion door rethrows whatever the fetch threw, so without this a reviewer who approves a
 * source whose page has since 404'd is shown `Request failed with status code 404` - an axios string
 * that names neither the cause (the source, not their click) nor the consequence (nothing was added,
 * the proposal is back in the queue). Verified on a live walk before this existed.
 *
 * The status says whose fault it was: the source site timing out (504) or failing (502) is an
 * upstream problem the reviewer can retry, not a malformed request, so it must not read as a 400.
 * Marked `expected` so a dead third-party link does not page as a server fault.
 *
 * Deliberate refusals pass through untouched: `assertCanWriteDataLakeTags` and `assertLakeWritable`
 * already say something true and specific, and rewording them here would bury a permission problem
 * behind a fetch message.
 */
function asReviewerFacingAdmissionError(err: unknown): unknown {
  if (err instanceof HTTPError) return err;
  // A non-axios network error (e.g. a storage-upload ECONNRESET, which createByUrl rethrows from
  // the same catch) is passed through untouched upstream, so it keeps its 500 and error-level log.
  const { code, isAxiosError } = (err ?? {}) as { code?: string; isAxiosError?: boolean };
  if (!isAxiosError && typeof code === 'string' && SOURCE_NETWORK_ERROR_CODES.has(code)) return err;
  const mapped = mapFetchFailure(err);
  if (mapped.statusCode >= 500) mapped.expected = true;
  return mapped;
}

function mapFetchFailure(err: unknown): HTTPError {
  const consequence = 'Nothing was added to the lake and the proposal is still waiting for review.';
  if (isSourceTimeout(err)) {
    return new GatewayTimeoutError(
      `Could not add this source: the source site did not respond in time. ${consequence} Try approving it again.`
    );
  }

  const { response, code, message, isAxiosError } = (err ?? {}) as {
    response?: { status?: number };
    code?: string;
    message?: string;
    isAxiosError?: boolean;
  };
  // A non-axios network error already returned unchanged above, so isAxiosError here means the
  // source fetch itself failed - a 502 the reviewer can retry, not an infrastructure fault.
  if (isAxiosError && response?.status) {
    return new BadGatewayError(
      `Could not add this source: the source returned HTTP ${response.status}. ${consequence}`
    );
  }
  if (isAxiosError && code && SOURCE_NETWORK_ERROR_CODES.has(code)) {
    return new BadGatewayError(`Could not add this source: the source site could not be reached. ${consequence}`);
  }
  return new BadRequestError(`Could not add this source: ${message ?? 'the fetch failed'}. ${consequence}`);
}

/** The same writability rule the upload and Slack doors apply. */
function assertLakeTakesNewFiles(lake: IDataLakeDocument): void {
  assertLakeWritable(lake);
  if (!isLakeIngestable(lake.status)) {
    throw new BadRequestError(`This data lake is ${lake.status} and cannot take new files`);
  }
}

export interface ApprovedProposal {
  proposal: IDataLakeProposalDocument;
  fabFile: AdmittedFile;
}

export interface ApproveOptions {
  /** Shown as the approver on the admitted file; the id alone is not readable to other lake editors. */
  approverName?: string;
}

export async function approveDataLakeProposal(
  proposalId: string,
  actor: ManageActor,
  adapters: ReviewAdapters,
  { approverName }: ApproveOptions = {}
): Promise<ApprovedProposal> {
  const { db, admitSource, serializeClaim, logger } = adapters;
  const approvedAt = new Date();
  const { proposal, lake, grants, claimed } = await serializeClaim(async () => {
    const reviewable = await resolveReviewable(proposalId, actor, { db });
    assertLakeTakesNewFiles(reviewable.lake);

    // Claim BEFORE admitting. The reverse order would let two reviewers (or one double-click) each
    // create a file before either wrote a status, admitting the same content twice - and a duplicate
    // member is exactly what this queue exists to prevent. The claim is a compare-and-set on
    // `status: 'pending'`, so the loser gets null here rather than a second admission.
    const claim = await db.dataLakeProposals.claimForReview(proposalId, {
      status: 'approved',
      reviewedByUserId: actor.userId,
      reviewedAt: approvedAt,
    });
    if (!claim) throw new BadRequestError('This proposal has already been reviewed');
    return { ...reviewable, claimed: claim };
  });

  const admitParams: AdmitSourceParams = {
    url: proposal.sourceUrl,
    // The lake's meta-tag ONLY. Producer-proposed tags are advisory metadata for the reviewer and
    // are deliberately not stamped: an arbitrary producer string can collide with another lake's
    // `fileTagPrefix`, and the prefix membership arm would then admit this file into that lake too
    // - a side door opened by a value no human ever approved.
    tags: [{ name: lake.datalakeTag, strength: DATALAKE_TAG_STRENGTH }],
    provenance: {
      sourceType: FabFileSourceType.PROPOSAL_APPROVAL,
      // Which run, which source, when retrieved, who approved - the provenance every admitted
      // document carries, readable by any lake editor auditing where content came from.
      sourceMetadata: {
        proposalId: proposal.id,
        sourceUrl: proposal.sourceUrl,
        producer: proposal.provenance.producer,
        runId: proposal.provenance.runId,
        query: proposal.provenance.query,
        retrievedAt: proposal.provenance.retrievedAt,
        approvedByUserId: actor.userId,
        ...(approverName && { approvedByName: approverName }),
        approvedAt,
      },
    },
  };

  let fabFile: AdmittedFile;
  try {
    // One retry, on a timeout only: the fetch runs before any row is written, so a timed-out
    // attempt left nothing behind, and a source the research run fetched moments ago is far more
    // likely slow than gone. Any other failure is not something an immediate retry fixes.
    fabFile = await admitSource(actor, admitParams).catch(err => {
      if (!isSourceTimeout(err)) throw err;
      return admitSource(actor, admitParams);
    });
  } catch (err) {
    // Admission failed after the claim, so the row would otherwise read as approved with nothing
    // admitted - unreviewable and invisible in the pending queue. Put it back and let the caller
    // report the real failure. If this release itself fails the row stays approved-but-empty, which
    // is still preferable to the alternative ordering's duplicate admission.
    //
    // Swallowed for the same reason `releaseClaim` swallows 11000 internally: this call exists to
    // compensate for the admission failure, so letting its own rejection propagate would replace the
    // one error worth reporting with a storage error about the compensation.
    await db.dataLakeProposals.releaseClaim(proposalId).catch(() => {});
    throw asReviewerFacingAdmissionError(err);
  }

  // The file has landed and carries the lake tag, so the approval SUCCEEDED - only the row's pointer
  // to it is missing. Throwing here would report a failure the reviewer cannot act on (a retry hits
  // the already-reviewed guard) for work that is already done, so the pointer is best-effort: a row
  // left without `admittedFabFileId` reads as not-held and the source is simply re-proposed visibly
  // (see the held-source check in `proposeDataLakeContent`).
  await db.dataLakeProposals.recordAdmission(proposalId, fabFile.id).catch(() => {});

  // Best-effort, same as recordAdmission above: the approval has already landed, so an audit-write
  // failure here must never turn into a reported failure for work that in fact succeeded.
  await recordLakeConfigChange(
    {
      actor,
      lake,
      grants,
      action: 'approve-proposal',
      changes: [proposalReviewChange(proposal, 'approved')],
    },
    { db, logger }
  );

  return { proposal: { ...claimed, admittedFabFileId: fabFile.id }, fabFile };
}

export async function declineDataLakeProposal(
  proposalId: string,
  actor: ManageActor,
  { reason }: { reason?: string },
  adapters: ReviewableAdapters
): Promise<IDataLakeProposalDocument> {
  const { db, logger } = adapters;
  // Resolved for its authorization only. No writability check: declining an archived lake's backlog
  // is housekeeping, not a write into it.
  const { lake, grants } = await resolveReviewable(proposalId, actor, { db });

  // The claim also strips the excerpt - a tombstone keeps the source identity, the reason, the
  // reviewer and the text fingerprint, never the declined material itself.
  const declined = await db.dataLakeProposals.claimForReview(proposalId, {
    status: 'declined',
    reviewedByUserId: actor.userId,
    reviewedAt: new Date(),
    declineReason: reason,
  });
  if (!declined) throw new BadRequestError('This proposal has already been reviewed');

  await recordLakeConfigChange(
    {
      actor,
      lake,
      grants,
      action: 'decline-proposal',
      changes: [proposalReviewChange(declined, 'declined')],
    },
    { db, logger }
  );

  return declined;
}

export interface RestoreAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] &
    Omit<ResolveReviewableAdapters['db'], 'dataLakeProposals'> & {
      dataLakeProposals: Pick<IDataLakeProposalRepository, 'findById' | 'findLatestBySourceKey' | 'restoreDeclined'>;
      // REQUIRED - see the matching note on ReviewAdapters.
      lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    };
}

/**
 * Undo a decline: put the tombstone back in the pending queue for a fresh decision. Only the LATEST
 * row for its source can be restored - an older declined row sits behind a later ruling (the source
 * came back changed and was approved or declined again), and reopening it would ask a question the
 * lake has already answered, or admit the source twice.
 */
export async function restoreDataLakeProposal(
  proposalId: string,
  actor: ManageActor,
  adapters: RestoreAdapters
): Promise<IDataLakeProposalDocument> {
  const { db, logger } = adapters;
  const { proposal, lake, grants } = await resolveReviewable(proposalId, actor, { db });
  if (proposal.status !== 'declined') throw new BadRequestError('Only a declined proposal can be restored');

  const latest = await db.dataLakeProposals.findLatestBySourceKey(proposal.dataLakeId, proposal.canonicalSourceKey);
  if (latest && latest.id !== proposal.id) {
    throw new BadRequestError('This source has been proposed again since it was declined, so it cannot be restored');
  }

  const result = await db.dataLakeProposals.restoreDeclined(proposalId);
  if (!result.restored) {
    throw new BadRequestError(
      result.reason === 'pending_exists'
        ? 'This source is already waiting for review'
        : 'This proposal is no longer declined'
    );
  }

  await recordLakeConfigChange(
    {
      actor,
      lake,
      grants,
      action: 'restore-proposal',
      changes: [proposalReviewChange(result.proposal, 'restored')],
    },
    { db, logger }
  );

  return result.proposal;
}
