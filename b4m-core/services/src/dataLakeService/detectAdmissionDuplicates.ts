import type { IDataLakeRepository, IFabFileRepository, LakeMembershipMemberInput } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import {
  describeSameIdentityAdmission,
  detectSameIdentityAdmission,
  type SameIdentityAdmission,
} from './admissionContract';
import { findMemberLakesForFile } from './chunkPolicyConflict';
import { lakeMembershipScope } from './lakeMembershipScope';

/**
 * The I/O half of the same-identity admission check (#2238): ask, for every lake an admitted file
 * belongs to, whether a sibling there already claims this document's identity.
 *
 * Runs at the POST-CHUNK checkpoint, and that placement is load-bearing rather than convenient. The
 * ruling an owner records is stamped with `groupIdentity`, which covers each member's
 * `serverTextHash`; run this BEFORE chunking and every member's fingerprint is still absent, so the
 * identity changes the moment chunking stamps it and the tombstone goes stale immediately - the
 * repair would re-ask about the very pair the uploader just decided on, which is the one thing the
 * `source: 'admission'` row exists to prevent.
 *
 * Report-only, and there is no throwing path: see `admissionContract.ts` for why a gate here would
 * have blocked the corrected copies that motivated this whole lane.
 *
 * How the lakes are resolved is `findMemberLakesForFile`'s answer, shared with the chunk-policy
 * recompute that runs beside this one - so both agree on what "a lake this file belongs to" means,
 * including the owner-anchored prefix arm. Static-registry lakes are outside it: they have no
 * document, so there is nothing to record a ruling against.
 */

/** The candidate's own fields. A subset of IFabFile, so the chunk handler can pass a lean object. */
export interface AdmissionDuplicateCandidate {
  id: string;
  userId: string;
  fileName?: string | null;
  relativePath?: string | null;
  driveFileId?: string | null;
  serverTextHash?: string | null;
  fileSize?: number | null;
  createdAt?: Date | null;
  tags?: { name: string }[];
}

/** One lake in which the admitted file duplicates an existing member. */
export interface AdmissionDuplicateFinding extends SameIdentityAdmission {
  lakeId: string;
  /** For the owner-facing offer; never logged - see `describeSameIdentityAdmission`. */
  lakeName: string;
}

export interface DetectAdmissionDuplicatesAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'find' | 'findByDatalakeTag'>;
    fabFiles: Pick<IFabFileRepository, 'findLakeMemberSiblingsByFileName'>;
  };
  logger?: Pick<Logger, 'warn'>;
}

/**
 * How many copies of ONE name the check reads per lake. Bounds a pathological name (`scan.pdf` on a
 * connector-synced lake) at the cost of at most a missed offer on a name held by more copies than
 * this, which is a repair job rather than a question worth raising at upload time.
 *
 * Below `DECIDABLE_GROUP_MEMBERS` deliberately, and the asymmetry is safe in this direction ONLY.
 * This read is report-only - the finding is logged and the offer left to the manager's door, and the
 * caller discards the return value - so a truncated group costs nothing durable. A door that STAMPS
 * a `groupIdentity` or re-derives one to compare against must not be narrowed this way, which is
 * why `applyAdmissionDecision` passes the wider bound rather than sharing this one.
 */
const SIBLING_SCAN_LIMIT = 50;

export async function detectAdmissionDuplicates(
  candidate: AdmissionDuplicateCandidate,
  { db, logger }: DetectAdmissionDuplicatesAdapters
): Promise<AdmissionDuplicateFinding[]> {
  // A nameless member can collide with nobody, and the grouping skips it outright. Short-circuited
  // before ANY read, so the overwhelmingly common non-lake chunk pays nothing for this check.
  if (!candidate.fileName) return [];

  const lakes = await findMemberLakesForFile(candidate, db.dataLakes);
  if (lakes.length === 0) return [];

  const fileName = candidate.fileName;
  const findings: AdmissionDuplicateFinding[] = [];

  for (const lake of lakes) {
    const siblings = await db.fabFiles.findLakeMemberSiblingsByFileName(
      lakeMembershipScope(lake),
      fileName,
      candidate.id,
      SIBLING_SCAN_LIMIT
    );
    if (siblings.length === 0) continue;

    const found = detectSameIdentityAdmission(asMember(candidate, lake.datalakeTag), siblings);
    if (!found) continue;

    logger?.warn(describeSameIdentityAdmission(lake.id, found));
    findings.push({ ...found, lakeId: lake.id, lakeName: lake.name });
  }

  return findings;
}

/**
 * The candidate as the grouping reads it, with the membership arm it reaches THIS lake by.
 *
 * The arm is derived from the file's own tags rather than read back through the sibling query, which
 * excludes the candidate by construction. Same rule the aggregation applies: the meta-tag is
 * authoritative when present, and anything else that is a member got there through the prefix arm.
 */
function asMember(candidate: AdmissionDuplicateCandidate, datalakeTag: string): LakeMembershipMemberInput {
  const carriesMetaTag = (candidate.tags ?? []).some(tag => tag?.name === datalakeTag);
  return {
    fabFileId: candidate.id,
    fileName: candidate.fileName,
    serverTextHash: candidate.serverTextHash,
    fileSize: candidate.fileSize,
    createdAt: candidate.createdAt,
    userId: candidate.userId,
    arm: carriesMetaTag ? 'meta-tag' : 'prefix',
    relativePath: candidate.relativePath,
    driveFileId: candidate.driveFileId,
  };
}
