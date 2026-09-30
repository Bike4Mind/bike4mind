import type { DataLakeConfig, DataLakeResource, IFabFileRepository } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';

type ReaderDataLake = dataLakeService.ReaderDataLake;

/**
 * The lake fields the public shape may read. Typed off the READER projection (READER_LAKE_FIELDS),
 * so an editor-only field can never reach `/api/v1` through here even when the caller holds the full
 * document: every caller gets the same narrow resource.
 */
export type PublicDataLakeSource = Pick<ReaderDataLake, 'id' | 'name' | 'slug'> &
  Partial<
    Pick<
      ReaderDataLake,
      | 'description'
      | 'organizationId'
      | 'isPublic'
      | 'status'
      | 'fileCount'
      | 'totalSizeBytes'
      | 'lastSyncAt'
      | 'createdAt'
      | 'updatedAt'
    >
  >;

export type LakeStats = { fileCount: number; totalSizeBytes: number };

const toIso = (value: Date | string | undefined | null): string | null => {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Project a lake onto the public `DataLakeResource`. `liveStats` overrides the persisted counts; a
 * built-in lake has no document, so its counts only exist live and its timestamps are null rather
 * than the synthetic values the access gate stamps on it.
 */
export function toPublicDataLake(lake: PublicDataLakeSource, liveStats?: LakeStats): DataLakeResource {
  const builtIn = dataLakeService.isFallbackLake(lake);
  return {
    id: lake.id,
    name: lake.name,
    slug: lake.slug,
    description: lake.description || null,
    organization_id: lake.organizationId || null,
    is_public: lake.isPublic ?? false,
    built_in: builtIn,
    status: lake.status ?? 'active',
    file_count: liveStats?.fileCount ?? lake.fileCount ?? 0,
    total_size_bytes: liveStats?.totalSizeBytes ?? lake.totalSizeBytes ?? 0,
    last_sync_at: toIso(lake.lastSyncAt),
    created_at: builtIn ? null : toIso(lake.createdAt),
    updated_at: builtIn ? null : toIso(lake.updatedAt),
  };
}

/**
 * Live counts for a built-in lake, off the same membership scope GET /api/data-lakes/:id uses so the
 * two doors agree. Undefined for a DB lake (its persisted stats are authoritative) and when the
 * aggregate fails: counts are supporting detail, so a read degrades to zeros rather than failing.
 */
export async function loadRegistryLakeStats(
  lake: Pick<DataLakeConfig, 'id' | 'datalakeTag' | 'fileTagPrefix'>,
  deps: { fabFiles: Pick<IFabFileRepository, 'computeDataLakeStats'>; logger?: Logger }
): Promise<LakeStats | undefined> {
  if (!dataLakeService.isFallbackLake(lake)) return undefined;
  try {
    const stats = await deps.fabFiles.computeDataLakeStats(dataLakeService.registryMembershipScope(lake));
    return { fileCount: stats.fileCount, totalSizeBytes: stats.totalSizeBytes };
  } catch (error) {
    deps.logger?.error('[dataLakes] registry lake stats unavailable; returning lake without counts', {
      err: error instanceof Error ? error.message : String(error),
      lakeId: lake.id,
    });
    return undefined;
  }
}
