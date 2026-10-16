import { DataLakeModel, FabFile } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import type { mongo } from 'mongoose';

export interface BackfillFabFileOwnerOrganizationOptions {
  dryRun: boolean;
  log?: (message: string) => void;
}

type CandidateLake = { id: string; organizationId: string; createdAt: Date };

type FileCandidates = { sourceLakeId?: string; organizationId?: string; lakes: CandidateLake[] };

/** A file in lakes of more than one org: the tiebreak picked `chosen`. */
export interface AmbiguousOwner {
  fileId: string;
  chosen: string;
  candidates: string[];
}

/** A file already stamped with an org other than the one its lakes resolve to; never overwritten. */
export interface OwnerConflict {
  fileId: string;
  stored: string;
  resolved: string;
}

/** A file stamped with an org although it is in no org lake now (e.g. it left the lake). Never cleared. */
export interface StaleOwner {
  fileId: string;
  stored: string;
}

export interface BackfillFabFileOwnerOrganizationReport {
  orgLakes: number;
  updated: number;
  alreadyOwned: number;
  ambiguous: AmbiguousOwner[];
  conflicts: OwnerConflict[];
  stale: StaleOwner[];
}

const WRITE_BATCH_SIZE = 500;

/**
 * Stamps FabFile.organizationId on files that belong to an org-owned lake, using the same rule as
 * the create door (fabFileService.pickOwnerOrganizationId over the lakes whose `datalake:*` meta-tag
 * the file carries). Files in no org lake stay personal and are not touched.
 *
 * Idempotent: a write only lands on a row with no organizationId, so re-runs and rows a create door
 * already stamped are no-ops. Soft-deleted rows are included - they still hold charged bytes until
 * purged, and the purge must refund the right owner.
 */
export async function backfillFabFileOwnerOrganization(
  options: BackfillFabFileOwnerOrganizationOptions
): Promise<BackfillFabFileOwnerOrganizationReport> {
  const { dryRun, log = console.log } = options;
  const lakes = await DataLakeModel.find(
    { organizationId: { $nin: [null, ''] } },
    { _id: 1, datalakeTag: 1, organizationId: 1, createdAt: 1 }
  ).lean<Array<{ _id: unknown; datalakeTag: string; organizationId: string; createdAt: Date }>>();

  const candidatesByFile = new Map<string, FileCandidates & { _id: mongo.ObjectId }>();
  for (const lake of lakes) {
    const candidate: CandidateLake = {
      id: String(lake._id),
      organizationId: lake.organizationId,
      createdAt: lake.createdAt,
    };
    // The raw collection: it skips the soft-delete filter, which would hide rows that still need an owner.
    const files = FabFile.collection.find(
      { 'tags.name': lake.datalakeTag },
      { projection: { _id: 1, sourceLakeId: 1, organizationId: 1 } }
    );
    for await (const file of files) {
      const key = String(file._id);
      const entry = candidatesByFile.get(key) ?? {
        _id: file._id,
        sourceLakeId: file.sourceLakeId ?? undefined,
        organizationId: file.organizationId ?? undefined,
        lakes: [] as CandidateLake[],
      };
      entry.lakes.push(candidate);
      candidatesByFile.set(key, entry);
    }
  }

  const report: BackfillFabFileOwnerOrganizationReport = {
    orgLakes: lakes.length,
    updated: 0,
    alreadyOwned: 0,
    ambiguous: [],
    conflicts: [],
    stale: [],
  };
  const pending: Array<{ _id: mongo.ObjectId; organizationId: string }> = [];

  for (const [fileId, entry] of candidatesByFile) {
    const resolved = fabFilesService.pickOwnerOrganizationId(entry.lakes, entry.sourceLakeId);
    if (!resolved) continue;

    const orgs = [...new Set(entry.lakes.map(lake => lake.organizationId))];
    if (orgs.length > 1) report.ambiguous.push({ fileId, chosen: resolved, candidates: orgs.sort() });

    if (entry.organizationId === resolved) report.alreadyOwned++;
    else if (entry.organizationId) report.conflicts.push({ fileId, stored: entry.organizationId, resolved });
    else pending.push({ _id: entry._id, organizationId: resolved });
  }

  const stamped = FabFile.collection.find(
    { organizationId: { $exists: true } },
    { projection: { _id: 1, organizationId: 1 } }
  );
  for await (const file of stamped) {
    if (!candidatesByFile.has(String(file._id))) {
      report.stale.push({ fileId: String(file._id), stored: String(file.organizationId) });
    }
  }

  if (dryRun) {
    report.updated = pending.length;
  } else {
    for (let start = 0; start < pending.length; start += WRITE_BATCH_SIZE) {
      const batch = pending.slice(start, start + WRITE_BATCH_SIZE);
      // Raw collection so updatedAt is not bumped; the $exists guard keeps a concurrent create's stamp.
      const result = await FabFile.collection.bulkWrite(
        batch.map(({ _id, organizationId }) => ({
          updateOne: { filter: { _id, organizationId: { $exists: false } }, update: { $set: { organizationId } } },
        })),
        { ordered: false }
      );
      report.updated += result.modifiedCount;
    }
  }

  log(
    `[backfill-fabfile-owner-organization] ${report.orgLakes} org lake(s); ` +
      `${dryRun ? 'would stamp' : 'stamped'} ${report.updated} file(s); ${report.alreadyOwned} already owned; ` +
      `${report.ambiguous.length} ambiguous; ${report.conflicts.length} conflict(s); ${report.stale.length} stale`
  );
  for (const row of report.ambiguous) {
    log(`  ambiguous ${row.fileId}: lakes of [${row.candidates.join(', ')}] -> ${row.chosen}`);
  }
  for (const row of report.conflicts) {
    log(`  conflict ${row.fileId}: stored ${row.stored}, lakes resolve ${row.resolved} (left as stored)`);
  }
  for (const row of report.stale) {
    log(`  stale ${row.fileId}: stored ${row.stored}, in no org lake (left as stored)`);
  }
  return report;
}
