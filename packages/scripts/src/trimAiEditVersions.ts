import type { IFabFileVersion } from '@bike4mind/common';
import { FabFile } from '@bike4mind/database';
import { trimVersionHistory } from '@bike4mind/utils';

export interface TrimAiEditVersionsOptions {
  dryRun: boolean;
  /** Edited versions kept per file, in addition to the original (v1). */
  maxEditedVersions: number;
  storage: { delete(key: string): Promise<unknown> };
  log?: (message: string) => void;
}

export interface TrimAiEditVersionsResult {
  /** Files over the cap - trimmed, or in a dry run, that would be. */
  files: number;
  /** Version entries dropped (or that would be). */
  versions: number;
  /** Bytes those entries' objects held, per their recorded fileSize. */
  bytes: number;
  /** Rows skipped because an edit changed them between the read and the conditional write. */
  skipped: number;
  /** Object deletes that failed after the DB write (orphaned objects, safe to re-sweep by hand). */
  deleteFailures: number;
}

/**
 * Trim AI-edited files already over the version cap, using the same rule as new edits
 * (trimVersionHistory: keep v1 plus the last N). The DB write is conditional on the row being
 * unchanged since the read, and objects are deleted only after it lands, so a concurrent edit is
 * never undone and a crash mid-run leaves at worst orphaned objects, never dangling versions.
 * Soft-deleted rows are excluded: deleteFabFile already removed their objects.
 */
export async function trimAiEditVersions(options: TrimAiEditVersionsOptions): Promise<TrimAiEditVersionsResult> {
  const { dryRun, maxEditedVersions, storage, log = console.log } = options;
  const result: TrimAiEditVersionsResult = { files: 0, versions: 0, bytes: 0, skipped: 0, deleteFailures: 0 };

  const cursor = FabFile.find(
    { [`versions.${maxEditedVersions + 1}`]: { $exists: true } },
    { filePath: 1, versions: 1 }
  )
    .lean<{ _id: unknown; filePath?: string; versions: IFabFileVersion[] }>()
    .cursor();

  for await (const row of cursor) {
    const { versions, droppedVersions } = trimVersionHistory(row.versions, maxEditedVersions);
    const bytes = droppedVersions.reduce((sum, v) => sum + (v.fileSize ?? 0), 0);

    if (!dryRun) {
      const { modifiedCount } = await FabFile.updateOne(
        { _id: row._id, filePath: row.filePath, versions: { $size: row.versions.length } },
        { $set: { versions } }
      );
      if (modifiedCount !== 1) {
        result.skipped += 1;
        log(`[trim-ai-edit-versions] ${String(row._id)}: changed since read, skipped`);
        continue;
      }
      const deletes = await Promise.allSettled(droppedVersions.map(v => storage.delete(v.filePath)));
      deletes.forEach((outcome, i) => {
        if (outcome.status === 'rejected') {
          result.deleteFailures += 1;
          log(`[trim-ai-edit-versions] ${String(row._id)}: failed to delete ${droppedVersions[i].filePath}`);
        }
      });
    }

    result.files += 1;
    result.versions += row.versions.length - versions.length;
    result.bytes += bytes;
    log(
      `[trim-ai-edit-versions] ${String(row._id)}: ${dryRun ? 'would drop' : 'dropped'} ` +
        `${row.versions.length - versions.length} version(s), ${bytes} bytes`
    );
  }

  return result;
}
