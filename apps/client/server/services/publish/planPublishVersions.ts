import type { ArtifactVersionMeta } from '@bike4mind/common';
import {
  archivedVersionBytes,
  checkPublishQuota,
  type PublishQuotaInput,
  type PublishQuotaResult,
} from './checkPublishQuota';

/** The slice of the page being replaced that version history is derived from. */
export interface PreviousVersionState {
  publishedAt: Date;
  ownerId: string;
  lastPublishedBy?: string;
  size: { totalBytes: number; fileCount: number };
  sha256Index?: string;
  versions?: Array<{ sha256Index: string; indexBytes?: number }>;
}

export interface PlanPublishVersionsInput {
  previous: PreviousVersionState | null;
  /** The replaced page's index.html bytes, when they could be read; they are archived as that version. */
  priorIndex: { length: number } | null;
  /** The version being published. */
  incoming: {
    sha256: string;
    publishedBy: string;
    publishedAt: Date;
    size: { totalBytes: number; fileCount: number };
    indexBytes: number;
  };
}

/**
 * Version history for a publish, deduped by content sha: backfills the replaced version when history
 * does not record it, then adds the incoming one unless it is an identical re-publish. `archivedBytes`
 * is what the page's archived versions occupy once this lands, for `checkPublishQuota`'s
 * `incoming.archivedBytes`. Shared by web finalize, v1 publish, restore and revise so they cannot drift;
 * callers write `versionsToPush` with `versionsPushUpdate`.
 */
export function planPublishVersions({ previous, priorIndex, incoming }: PlanPublishVersionsInput): {
  versionsToPush: ArtifactVersionMeta[];
  archivedBytes: number;
} {
  const haveShas = new Set((previous?.versions ?? []).map(v => v.sha256Index));
  const versionsToPush: ArtifactVersionMeta[] = [];
  if (previous?.sha256Index && !haveShas.has(previous.sha256Index)) {
    versionsToPush.push({
      publishedAt: previous.publishedAt,
      publishedBy: previous.lastPublishedBy ?? previous.ownerId,
      size: previous.size,
      sha256Index: previous.sha256Index,
      ...(priorIndex ? { indexBytes: priorIndex.length } : {}),
    });
    haveShas.add(previous.sha256Index);
  }
  if (!haveShas.has(incoming.sha256)) {
    versionsToPush.push({
      publishedAt: incoming.publishedAt,
      publishedBy: incoming.publishedBy,
      size: incoming.size,
      sha256Index: incoming.sha256,
      indexBytes: incoming.indexBytes,
    });
  }
  return {
    versionsToPush,
    archivedBytes: archivedVersionBytes([...(previous?.versions ?? []), ...versionsToPush], incoming.sha256),
  };
}

/** The `$push` that appends a publish's new history entries; every route writing `versionsToPush` uses it. */
export function versionsPushUpdate(versionsToPush: ArtifactVersionMeta[]) {
  return { $push: { versions: { $each: versionsToPush } } };
}

/**
 * `planPublishVersions` plus the cumulative storage quota check, for the routes that replace a page's
 * current version (v1 publish and web finalize). The incoming footprint is `incoming.size`, and
 * `replacing` excludes the page being overwritten so a re-publish is not double-counted; its archived
 * versions are added back as they stand after this publish, since replacing the current version with
 * new content archives it. Callers map `quota.ok === false` to their own error response.
 */
export async function planVersionedPublish(
  input: PlanPublishVersionsInput & {
    quota: Pick<PublishQuotaInput, 'ownerId' | 'orgScopeId' | 'isAdmin' | 'replacing'>;
  }
): Promise<{ versionsToPush: ArtifactVersionMeta[]; quota: PublishQuotaResult }> {
  const { quota: quotaInput, ...plan } = input;
  const { versionsToPush, archivedBytes } = planPublishVersions(plan);
  const quota = await checkPublishQuota({
    ...quotaInput,
    incoming: {
      bytes: plan.incoming.size.totalBytes,
      fileCount: plan.incoming.size.fileCount,
      archivedBytes,
    },
  });
  return { versionsToPush, quota };
}
