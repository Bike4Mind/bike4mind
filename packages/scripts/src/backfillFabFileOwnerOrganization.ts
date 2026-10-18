import { DataLakeModel, FabFile } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import type { mongo } from 'mongoose';

export interface BackfillFabFileOwnerOrganizationOptions {
  dryRun: boolean;
  log?: (message: string) => void;
}

type CandidateLake = { id: string; organizationId: string; createdAt: Date };

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

  const lakesByTag = new Map<string, CandidateLake>(
    lakes.map(lake => [
      lake.datalakeTag,
      { id: String(lake._id), organizationId: lake.organizationId, createdAt: lake.createdAt },
    ])
  );

  const report: BackfillFabFileOwnerOrganizationReport = {
    orgLakes: lakes.length,
    updated: 0,
    alreadyOwned: 0,
    ambiguous: [],
    conflicts: [],
    stale: [],
  };
  const pending: Array<{ _id: mongo.ObjectId; organizationId: string }> = [];

  const flush = async () => {
    const batch = pending.splice(0, pending.length);
    if (dryRun) {
      report.updated += batch.length;
      return;
    }
    if (batch.length === 0) return;
    // Raw collection so updatedAt is not bumped; the $exists guard keeps a concurrent create's stamp.
    const result = await FabFile.collection.bulkWrite(
      batch.map(({ _id, organizationId }) => ({
        updateOne: { filter: { _id, organizationId: { $exists: false } }, update: { $set: { organizationId } } },
      })),
      { ordered: false }
    );
    report.updated += result.modifiedCount;
  };

  // One streaming pass, so memory stays flat however many files there are: every file in an org lake,
  // plus every already-stamped file (to report the stale ones). The raw collection skips the
  // soft-delete filter, which would hide rows that still need an owner.
  const files = FabFile.collection.find(
    { $or: [{ 'tags.name': { $in: [...lakesByTag.keys()] } }, { organizationId: { $exists: true } }] },
    { projection: { _id: 1, tags: 1, sourceLakeId: 1, organizationId: 1 } }
  );
  for await (const file of files) {
    const fileId = String(file._id);
    const stored: string | undefined = file.organizationId ?? undefined;
    const tagNames: string[] = (file.tags ?? []).map((tag: { name: string }) => tag.name);
    const fileLakes = [...new Set(tagNames.flatMap(name => lakesByTag.get(name) ?? []))];

    const resolved = fabFilesService.pickOwnerOrganizationId(fileLakes, file.sourceLakeId ?? undefined);
    if (!resolved) {
      if (stored) report.stale.push({ fileId, stored: String(stored) });
      continue;
    }

    const orgs = [...new Set(fileLakes.map(lake => lake.organizationId))];
    if (orgs.length > 1) report.ambiguous.push({ fileId, chosen: resolved, candidates: orgs.sort() });

    if (stored === resolved) report.alreadyOwned++;
    else if (stored) report.conflicts.push({ fileId, stored, resolved });
    else pending.push({ _id: file._id, organizationId: resolved });

    if (pending.length >= WRITE_BATCH_SIZE) await flush();
  }
  await flush();

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
