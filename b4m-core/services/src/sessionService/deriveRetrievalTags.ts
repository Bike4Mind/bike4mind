import type { IFabFileRepository, IUserDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { datalakeTagsFrom } from '../dataLakeService/getDataLakePrompts';

/** The resolved lake access a caller holds, if the host can supply it. See the note below. */
export interface LakeAccessForDerivation {
  dataLakeTags: string[];
  dataLakeTagPrefixes: string[];
  scopedTagPrefixes: string[];
}

export interface DeriveRetrievalTagsAdapters {
  db: { fabFiles: IFabFileRepository };
  logger?: Logger;
  /**
   * Resolves the caller's lake access. OPTIONAL, and the reason the derivation below has two arms.
   *
   * The ownership/share reader cannot see a file reached through LAKE MEMBERSHIP - an organization
   * lake widens reach via the lake creator's identity, so a member's teammate-authored lake file is
   * invisible to it. A host that can resolve lake access lets the derivation ask through the lake arm
   * as well; a host that cannot degrades to the ownership read, which under-derives rather than
   * over-deriving, so the failure direction is "no narrowing" and never "wrong narrowing".
   */
  resolveLakeAccess?: () => Promise<LakeAccessForDerivation>;
}

/**
 * The `datalake:` tags of the lake(s) a session's starting files belong to.
 *
 * Shared by session create AND update: attaching a lake file to an already-open session is the most
 * ordinary way a user reaches a lake, and deriving only at create left that whole path unscoped.
 *
 * Permission-correct by construction. The ownership arm resolves through
 * `shareable.findAllAccessibleByIds` (the reader `addFilesToProjects` uses); the lake arm passes
 * `restrictToFileIds` with the caller's own resolved lake args and NO `skipOwnership`, so every id
 * must still be admitted. `knowledgeIds` is client-writable, so neither arm may skip its filter.
 */
export async function deriveRetrievalTagsFromFiles(
  user: IUserDocument,
  knowledgeIds: string[],
  adapters: DeriveRetrievalTagsAdapters
): Promise<string[]> {
  if (knowledgeIds.length === 0) return [];
  const tagNames: string[] = [];

  try {
    const owned = await adapters.db.fabFiles.shareable.findAllAccessibleByIds(user, knowledgeIds);
    tagNames.push(...owned.flatMap(f => f.tags?.map(t => t.name) ?? []));
  } catch (err) {
    adapters.logger?.warn(
      `[sessionService] ownership-arm lake-tag derivation failed: ${(err as Error)?.message}`
    );
  }

  let reachable: Set<string> | undefined;
  if (adapters.resolveLakeAccess) {
    try {
      const access = await adapters.resolveLakeAccess();
      reachable = new Set(access.dataLakeTags);
      if (access.dataLakeTags.length > 0) {
        const res = await adapters.db.fabFiles.search(
          user.id,
          '',
          { tags: [], shared: false, restrictToFileIds: knowledgeIds },
          { page: 1, limit: knowledgeIds.length },
          { by: 'fileName', direction: 'asc' },
          {
            textSearch: false,
            includeShared: true,
            userGroups: user.groups || [],
            dataLakeTags: access.dataLakeTags,
            dataLakeTagPrefixes: access.dataLakeTagPrefixes,
            scopedTagPrefixes: access.scopedTagPrefixes,
            excludeContent: true,
          }
        );
        tagNames.push(...res.data.flatMap(f => f.tags?.map(t => t.name) ?? []));
      }
    } catch (err) {
      adapters.logger?.warn(`[sessionService] lake-arm lake-tag derivation failed: ${(err as Error)?.message}`);
    }
  }

  const derived = datalakeTagsFrom(tagNames);
  if (!reachable) return derived;
  // Intersected against the caller's reachable lakes. The ownership arm collects tags off any file
  // the caller can merely READ, so a 1:1-shared file carrying a stale or foreign lake tag would
  // otherwise persist a scope pointing at a lake they cannot reach - which narrows the session to
  // nothing rather than to that lake, and (because a non-empty tag list reads as "already
  // lake-scoped") also switches off the personal-corpus suppression permanently.
  return derived.filter(tag => reachable.has(tag));
}
