import { secureParameters, BadRequestError } from '@bike4mind/utils';
import { IDataLakeRepository, IFabFileRepository, ITagRepository, LakeAuditPrincipal } from '@bike4mind/common';
import { z } from 'zod';
import { couldMatchTagPrefixArmLoosely, loadPrefixArmCandidateLakes } from '../dataLakeService/prefixArmMembership';
import { recomputeLakeStats } from '../dataLakeService/recomputeLakeStats';
import { isDataLakeTagName } from './tagName';
import type { LakeConfigAuditAdapters } from '../dataLakeService/recordLakeConfigChange';

const tagRemoveSchema = z.object({
  id: z.string(),
});

type TagRemoveParams = z.infer<typeof tagRemoveSchema>;

interface TagRemoveAdapters {
  db: {
    tags: Pick<ITagRepository, 'findByIdAndUserId' | 'delete'>;
    fabFiles: Pick<IFabFileRepository, 'removeTagByUserId' | 'computeDataLakeStats'>;
    dataLakes: Pick<IDataLakeRepository, 'find' | 'setStats' | 'activateIfDraft'>;
    // The config-audit repos, OPTIONAL and forwarded straight to recomputeLakeStats below: a
    // prefix-arm rename or delete can flip a draft lake to active, and without these that
    // transition records nothing at all. Optional because this service has many callers and the
    // recorder degrades to a no-op when they are absent - see LakeConfigAuditAdapters.
    lakeConfigChangeEvents?: LakeConfigAuditAdapters['db']['lakeConfigChangeEvents'];
    adminSettings?: LakeConfigAuditAdapters['db']['adminSettings'];
  };
  /**
   * Forwarded to recomputeLakeStats so a best-effort audit failure on the draft -> active flip is
   * reported through the caller's structured logger instead of falling to `console.warn`, where
   * log-based alerting cannot see it. Optional, matching the audit repos above: this service has
   * many callers, and an absent logger degrades to the console fallback rather than failing.
   */
  logger?: LakeConfigAuditAdapters['logger'];
  /**
   * The resolved audit principal for an API-key caller (undefined for a session caller) - see
   * `lakeConfigAuditPrincipal`. Rides on the actor handed to recomputeLakeStats, so a key-driven
   * delete that flips a draft lake to active names the key rather than the human it acts for,
   * matching every other audited config-write door (#1917).
   */
  auditPrincipal?: LakeAuditPrincipal;
  /**
   * Called only when the tag being deleted matches a candidate lake's `fileTagPrefix` (a possible
   * membership leave) - mirrors the same callback on `fabFileService/toggleTags`. Manage-rights
   * needs no gate here (see the doc above: this call only ever touches files `userId` owns), but
   * API-key SCOPE is a separate axis - a `files:write`-only key should not be able to walk a file
   * out of a lake any more than `files/tags/toggle.ts` lets it walk one in. Optional so every other
   * caller of this service (which has nothing to do with lakes) is unaffected.
   */
  assertWriteScope?: () => void;
}

/**
 * Delete a tag document AND strip its name off every file that carried it. Deleting the document
 * alone left the name orphaned: chips stopped rendering (they intersect tag documents with the
 * file's strings) while the Workspaces tag counts, which read the strings, kept counting it.
 *
 * A `datalake:` name is refused. Membership in a lake IS that string on the file, so stripping one
 * would silently evict every file from the lake. Such a document is reachable - accepting an
 * invite to a shared lake file mints one for the invitee - so this is a real path, not a
 * theoretical one.
 *
 * An ORDINARY name can still be a lake's `fileTagPrefix` content tag, which is membership too
 * (since #1263). No manage-rights gate is needed for THAT signal here, unlike the single-file
 * doors: this call already only ever touches files `userId` owns, and prefix-arm membership
 * requires the file's owner to BE the lake's creator, so any lake this could possibly affect was
 * necessarily created by this same `userId` - the gate would never have anything to refuse. What
 * the bulk strip below does NOT do on its own is recompute the affected lakes' stats.
 */
export const remove = async (userId: string, params: TagRemoveParams, adapters: TagRemoveAdapters) => {
  const { db, logger, auditPrincipal, assertWriteScope } = adapters;
  const { id } = secureParameters(params, tagRemoveSchema);

  const tag = await db.tags.findByIdAndUserId(id, userId);

  if (!tag) {
    throw new Error('Tag Service - Delete: Tag not found');
  }

  if (isDataLakeTagName(tag.name)) {
    throw new BadRequestError('Tag Service - Delete: a data lake membership tag cannot be deleted here');
  }

  // Every usable fileTagPrefix ends in ':' (see prefixArmTagNames), so a colon-free name can never
  // be one - skip the lake lookup entirely for the common plain-tag case. Resolved and gated BEFORE
  // the write below (not after, alongside the recompute) so a denied key never sees the strip
  // applied - this call is not transactional, and a 403 that follows the mutation would report
  // failure while leaving the file evicted from the lake.
  const affectedLakes = tag.name.includes(':')
    ? (await loadPrefixArmCandidateLakes([userId], { db })).filter(lake =>
        couldMatchTagPrefixArmLoosely(tag.name, lake.fileTagPrefix)
      )
    : [];

  if (affectedLakes.length > 0) assertWriteScope?.();

  // Files first, tag document second. This order converges under retry: if the delete below fails,
  // the document still names the tag, so re-running the same request finds the stragglers. The
  // reverse order strands them - the name is gone from the only record that could locate them.
  const filesUpdated = await db.fabFiles.removeTagByUserId(userId, tag.name);

  await db.tags.delete(tag.id);

  if (affectedLakes.length > 0) {
    // Recomputes even for a lake where a surviving sibling tag kept some files members - harmless
    // (the aggregate re-derives the true count either way), and cheaper than re-deriving per file
    // which of these lakes actually lost a member. Independent per-lake recomputes, so run them
    // concurrently rather than one at a time.
    // `actor` is the tag's owner: a rename/delete here is a user action, so an auto-activate it
    // causes should not read as `system`. `isAdmin` is immaterial on this path - recomputeLakeStats
    // forces the rung to `system` because activateIfDraft authorizes nothing.
    await Promise.all(
      affectedLakes.map(lake =>
        recomputeLakeStats(lake, { db, logger }, { actor: { userId, isAdmin: false, auditPrincipal } })
      )
    );
  }

  return { id: tag.id, name: tag.name, filesUpdated };
};
