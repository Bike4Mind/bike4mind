import type {
  DataLakeProposalProvenance,
  IDataLakeDocument,
  IDataLakeProposalDocument,
  IDataLakeProposalRepository,
  IFabFileRepository,
} from '@bike4mind/common';
import {
  DATALAKE_TAG_PREFIX,
  DATA_LAKE_PROPOSAL_EXCERPT_MAX_CHARS,
  DATA_LAKE_PROPOSAL_MAX_TAGS,
} from '@bike4mind/common';
import { computeServerTextHash } from './admissionContract';
import { canonicalSourceKey, sanitizeSourceUrlForRecord } from './canonicalSourceKey';

/**
 * The producer-facing door of the acquisition queue (#1671). A producer never writes into a lake and
 * never writes a proposal row itself: it hands a candidate here, and this decides whether the lake
 * has anything to gain from a human looking at it.
 *
 * Dedup is keyed on CANONICAL SOURCE IDENTITY, with the normalized-text hash as the secondary
 * "changed materially" signal. Neither of the two tempting alternatives is used, deliberately:
 * `FabFile.contentHash` is a client-side hash of raw bytes written by only the presigned-URL upload
 * doors and never verified server-side (so proposal-created files carry none, and a hash of
 * extracted text could never equal the byte hash of the PDF it came from), and the vector index is
 * torn down per member by convergence, so an overlapping run would propose content the lake already
 * holds - the exact failure dedup exists to prevent.
 */

/** The lake fields a proposal decision needs. Taking the resolved document avoids a refetch. */
export type ProposalLake = Pick<IDataLakeDocument, 'id' | 'datalakeTag'>;

/** What a producer hands over. Everything derived from it - key, hash, excerpt - is derived HERE. */
export interface ProposalCandidate {
  /** Where the candidate was retrieved from. Keyed, sanitized and recorded by this service. */
  sourceUrl: string;
  title: string;
  /**
   * The text the producer actually retrieved. Passed whole, not pre-hashed and not pre-truncated:
   * the hash must be `computeServerTextHash`'s to be comparable with `FabFile.serverTextHash`, and
   * a producer-supplied hash would be an unverifiable claim in the one place dedup depends on.
   * Optional, but a producer that means to stay useful over time should treat it as REQUIRED: the
   * changed-materially rule compares two hashes and `changedMaterially` is false whenever either is
   * absent, so a producer that never sends text can never clear a tombstone. Every later run on a
   * declined source answers `suppressed_by_tombstone` no matter how much the page moved. That is the
   * right default for a human "no" (we cannot tell that it changed, so we do not re-ask), but it
   * means source-keyed dedup alone is a one-way door.
   *
   * CONTRACT A PRODUCER MUST HONOR: this should be the text the INGESTION DOOR would extract from
   * the same URL (`fetchAndParseURL` -> `SmartChunker.getExtractedText`), not the producer's own
   * rendering of the page. The hash is only whitespace- and chunk-policy-insensitive, not
   * extractor-insensitive: a producer that keeps navigation chrome the door strips will hash
   * differently from the member the door admitted, and both text-hash comparisons below then
   * silently miss. The failure is a duplicate proposal a human must decline, never a wrong
   * admission - source-keyed dedup, the primary key, is unaffected.
   */
  text?: string;
  /** Advisory tags for the admitted file. Reserved-namespace entries are dropped here (see below). */
  proposedTags?: string[];
  /** 0..1, display only. Out-of-range values are dropped rather than clamped - see below. */
  confidence?: number;
  provenance: DataLakeProposalProvenance;
}

export type ProposalOutcome =
  | { outcome: 'proposed'; proposal: IDataLakeProposalDocument }
  /** An open proposal for this source is already awaiting a human. */
  | { outcome: 'duplicate_pending'; proposalId: string }
  /** The lake already holds this content - by a prior approval of the source, or by text. */
  | { outcome: 'already_in_lake'; reason: 'prior_approval' | 'lake_member' }
  /** A human declined this source and it has not come back materially changed. */
  | { outcome: 'suppressed_by_tombstone'; proposalId: string }
  /** Nothing to key the source on, so it could never be deduped. */
  | { outcome: 'unusable_source'; reason: 'not_http_url' };

export interface ProposalAdapters {
  db: {
    dataLakeProposals: Pick<IDataLakeProposalRepository, 'findLatestBySourceKey' | 'createProposal'>;
    fabFiles: Pick<IFabFileRepository, 'findByServerTextHashesInDataLake' | 'isLiveDataLakeMember'>;
  };
}

/**
 * Producer-proposed tags, minus anything in the reserved `datalake:` namespace. A meta-tag is
 * permission-bearing - stamping one is what puts a file in a lake - so honoring a producer's
 * `datalake:someone-elses-lake` would let a proposal approved for THIS lake admit content into
 * another one. Same rule as the write gate's `extractDataLakeMetaTags`, applied here so the tag can
 * never reach the queue, let alone the file.
 */
const sanitizeProposedTags = (tags: readonly string[] | undefined): string[] =>
  Array.from(
    new Set(
      (tags ?? [])
        .filter((tag): tag is string => typeof tag === 'string')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0 && !tag.toLowerCase().startsWith(DATALAKE_TAG_PREFIX))
    )
  ).slice(0, DATA_LAKE_PROPOSAL_MAX_TAGS);

/**
 * A confidence outside 0..1 is a producer bug, and this value is shown to a human deciding whether
 * to trust a source. Dropped rather than clamped: an absent score reads as "no signal", where a
 * clamped 1 would read as "certain" - the most misleading value a bug could produce.
 */
const usableConfidence = (confidence: number | undefined): number | undefined =>
  typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    ? confidence
    : undefined;

/**
 * True only when both hashes exist AND differ. Absent on either side is never "changed": the
 * tombstone stands and an approved source is not re-proposed, because "we cannot tell" must not
 * resolve to "admit it again". The caller reports the skip, so this is not silent suppression.
 */
const changedMaterially = (stored: string | null | undefined, candidate: string | undefined): boolean =>
  !!stored && !!candidate && stored !== candidate;

export async function proposeDataLakeContent(
  lake: ProposalLake,
  candidate: ProposalCandidate,
  { db }: ProposalAdapters
): Promise<ProposalOutcome> {
  const sourceKey = canonicalSourceKey(candidate.sourceUrl);
  const recordedUrl = sanitizeSourceUrlForRecord(candidate.sourceUrl);
  // Both derive from the same parse, so one being null means the other is too; checked together so
  // a future change to either cannot leave a row with a key and no openable URL.
  if (!sourceKey || !recordedUrl) return { outcome: 'unusable_source', reason: 'not_http_url' };

  const textHash = computeServerTextHash(candidate.text);

  // The PRIMARY key: what this lake has already decided about this source. A read, not a claim - the
  // create below is where a concurrent run for the same source is actually excluded.
  const latest = await db.dataLakeProposals.findLatestBySourceKey(lake.id, sourceKey);
  if (latest?.status === 'pending') return { outcome: 'duplicate_pending', proposalId: latest.id };
  if (latest?.status === 'approved' && !changedMaterially(latest.textHash, textHash)) {
    // The stored ruling alone is not the answer: an admitted file can be archived or deleted
    // afterwards by ordinary file management, and a prior approval with no live file behind it would
    // otherwise keep answering `already_in_lake` forever - leaving the source permanently
    // unproposable with no human ever seeing it again, the failure the tombstone design avoids.
    // A missing `admittedFabFileId` is the same answer: it is the approved-but-empty row a failed
    // admission leaves, which never put anything in the lake either. Falling through re-proposes it
    // VISIBLY, carrying `priorDisposition: 'approved'` so the reviewer sees the history.
    // NOTE: "live" here counts a file still mid-ingest as held - see isLiveDataLakeMember for why
    // this arm must NOT reuse the hash arm's 'pending'-excluding predicate.
    const stillHeld =
      !!latest.admittedFabFileId &&
      (await db.fabFiles.isLiveDataLakeMember(latest.admittedFabFileId, lake.datalakeTag));
    if (stillHeld) return { outcome: 'already_in_lake', reason: 'prior_approval' };
  }
  if (latest?.status === 'declined' && !changedMaterially(latest.textHash, textHash)) {
    return { outcome: 'suppressed_by_tombstone', proposalId: latest.id };
  }

  // The SECONDARY signal: the same text may already be in the lake under a different source, or
  // through a door that never went through this queue at all.
  if (textHash) {
    const existing = await db.fabFiles.findByServerTextHashesInDataLake([textHash], lake.datalakeTag);
    if (existing.length > 0) return { outcome: 'already_in_lake', reason: 'lake_member' };
  }

  const created = await db.dataLakeProposals.createProposal({
    dataLakeId: lake.id,
    sourceUrl: recordedUrl,
    canonicalSourceKey: sourceKey,
    title: candidate.title,
    // Truncated for the reviewer's benefit only - the hash above covers the FULL text, so display
    // truncation never weakens dedup.
    excerpt: candidate.text?.slice(0, DATA_LAKE_PROPOSAL_EXCERPT_MAX_CHARS),
    textHash,
    proposedTags: sanitizeProposedTags(candidate.proposedTags),
    confidence: usableConfidence(candidate.confidence),
    provenance: candidate.provenance,
    // Only set when a prior ruling exists and the text moved past it - the reviewer sees that this
    // source has been here before instead of being asked the same question twice with no context.
    ...(latest ? { priorDisposition: latest.status } : {}),
  });

  // The read above is not a lock, so an overlapping run for the same source can land its pending row
  // between that read and this write. The DB's pending-uniqueness index is what makes that visible
  // instead of admitting a second open question, and the answer is the one the read would have given.
  if (!created.created) return { outcome: 'duplicate_pending', proposalId: created.pendingProposalId };

  return { outcome: 'proposed', proposal: created.proposal };
}
