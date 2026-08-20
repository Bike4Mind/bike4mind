import type {
  AccessContext,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeProposalDocument,
  IDataLakeProposalRepository,
  IDataLakeRepository,
} from '@bike4mind/common';
import { DATALAKE_TAG_STRENGTH, FabFileSourceType } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, HTTPError, NotFoundError } from '@bike4mind/utils';
import { assertLakeWritable } from './assertLakeAccess';
import { resolveCanManageLake } from './authorizeLakeManage';

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

export interface ReviewAdapters {
  db: {
    dataLakeProposals: Pick<
      IDataLakeProposalRepository,
      'findById' | 'claimForReview' | 'recordAdmission' | 'releaseClaim'
    >;
    dataLakes: Pick<IDataLakeRepository, 'findById'>;
    // Optional for the same reason as everywhere else in this family: absent, manage falls back to
    // createdByUserId + the org-admin rung (see loadActiveLakeGrants).
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  };
  /**
   * Takes the whole ACTOR, not just its id. The admission door runs its own lake-tag write gate, and
   * that gate needs the same principal the review gate above resolved - `administeredOrgIds` in
   * particular cannot be recovered from a userId. Passing only the id made the write gate strictly
   * narrower than the review gate, so a curator or org admin cleared the 403, had the row claimed,
   * and was then refused the admission with nothing retryable.
   */
  admitSource(actor: AccessContext, params: AdmitSourceParams): Promise<AdmittedFile>;
}

type ReviewableAdapters = Omit<ReviewAdapters, 'admitSource'>;

/**
 * Resolve the proposal and its lake, and assert the caller may rule on it. Not-found for a missing
 * proposal or a vanished lake; manage-denied for a caller without write authority over the lake,
 * mirroring `removeFileFromLake`. Reviewing is a lake-management right, not a lake-read one: anyone
 * who can read a lake must not be able to decide what enters it.
 */
async function resolveReviewable(
  proposalId: string,
  actor: AccessContext,
  { db }: ReviewableAdapters
): Promise<{ proposal: IDataLakeProposalDocument; lake: IDataLakeDocument }> {
  const proposal = await db.dataLakeProposals.findById(proposalId);
  if (!proposal) throw new NotFoundError('Proposal not found');

  const lake = await db.dataLakes.findById(proposal.dataLakeId);
  if (!lake) throw new NotFoundError('Proposal not found');

  // 403, matching the sibling manage-gated read (`data-lakes/[id]/spend.ts`): the lake read gate
  // above has already cleared the caller, so refusing here is an authorization answer, not a
  // malformed request. Any change to this status belongs in the list route too.
  if (!(await resolveCanManageLake(lake, actor, { db }))) {
    throw new ForbiddenError('You do not have permission to review proposals for this data lake');
  }
  return { proposal, lake };
}

/**
 * Turn an admission failure into something the REVIEWER can act on.
 *
 * The ingestion door rethrows whatever the fetch threw, so without this a reviewer who approves a
 * source whose page has since 404'd is shown `Request failed with status code 404` - an axios string
 * that names neither the cause (the source, not their click) nor the consequence (nothing was added,
 * the proposal is back in the queue). Verified on a live walk before this existed.
 *
 * Deliberate refusals pass through untouched: `assertCanWriteDataLakeTags` and `assertLakeWritable`
 * already say something true and specific, and rewording them here would bury a permission problem
 * behind a fetch message.
 */
function asReviewerFacingAdmissionError(err: unknown): unknown {
  if (err instanceof HTTPError) return err;

  const status = (err as { response?: { status?: number } })?.response?.status;
  const detail = status
    ? `the source returned HTTP ${status}`
    : ((err as { message?: string })?.message ?? 'the fetch failed');
  return new BadRequestError(
    `Could not add this source: ${detail}. Nothing was added to the lake and the proposal is still waiting for review.`
  );
}

/** The same writability rule the upload and Slack doors apply: only a draft or active lake takes new files. */
function assertLakeTakesNewFiles(lake: IDataLakeDocument): void {
  assertLakeWritable(lake);
  if (lake.status !== 'draft' && lake.status !== 'active') {
    throw new BadRequestError(`This data lake is ${lake.status} and cannot take new files`);
  }
}

export interface ApprovedProposal {
  proposal: IDataLakeProposalDocument;
  fabFile: AdmittedFile;
}

export async function approveDataLakeProposal(
  proposalId: string,
  actor: AccessContext,
  adapters: ReviewAdapters
): Promise<ApprovedProposal> {
  const { db, admitSource } = adapters;
  const { proposal, lake } = await resolveReviewable(proposalId, actor, { db });
  assertLakeTakesNewFiles(lake);

  const approvedAt = new Date();
  // Claim BEFORE admitting. The reverse order would let two reviewers (or one double-click) each
  // create a file before either wrote a status, admitting the same content twice - and a duplicate
  // member is exactly what this queue exists to prevent. The claim is a compare-and-set on
  // `status: 'pending'`, so the loser gets null here rather than a second admission.
  const claimed = await db.dataLakeProposals.claimForReview(proposalId, {
    status: 'approved',
    reviewedByUserId: actor.userId,
    reviewedAt: approvedAt,
  });
  if (!claimed) throw new BadRequestError('This proposal has already been reviewed');

  let fabFile: AdmittedFile;
  try {
    fabFile = await admitSource(actor, {
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
          approvedAt,
        },
      },
    });
  } catch (err) {
    // Admission failed after the claim, so the row would otherwise read as approved with nothing
    // admitted - unreviewable and invisible in the pending queue. Put it back and let the caller
    // report the real failure. If this release itself fails the row stays approved-but-empty, which
    // is still preferable to the alternative ordering's duplicate admission.
    await db.dataLakeProposals.releaseClaim(proposalId);
    throw asReviewerFacingAdmissionError(err);
  }

  await db.dataLakeProposals.recordAdmission(proposalId, fabFile.id);
  return { proposal: { ...claimed, admittedFabFileId: fabFile.id }, fabFile };
}

export async function declineDataLakeProposal(
  proposalId: string,
  actor: AccessContext,
  { reason }: { reason?: string },
  adapters: ReviewableAdapters
): Promise<IDataLakeProposalDocument> {
  const { db } = adapters;
  // Resolved for its authorization only. No writability check: declining an archived lake's backlog
  // is housekeeping, not a write into it.
  await resolveReviewable(proposalId, actor, { db });

  // The claim also strips the excerpt - a tombstone keeps the source identity, the reason, the
  // reviewer and the text fingerprint, never the declined material itself.
  const declined = await db.dataLakeProposals.claimForReview(proposalId, {
    status: 'declined',
    reviewedByUserId: actor.userId,
    reviewedAt: new Date(),
    declineReason: reason,
  });
  if (!declined) throw new BadRequestError('This proposal has already been reviewed');
  return declined;
}
