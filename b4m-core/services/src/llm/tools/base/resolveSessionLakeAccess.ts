import { effectiveIncludeLibraryFiles } from '@bike4mind/common';
import { datalakeTagsFrom } from '../../../dataLakeService/getDataLakePrompts';
import { getDynamicDataLakeAccess } from '../../../dataLakeService/getDynamicDataLakeTags';
import { sessionGroundsOnNoLake, type ResolvedLakeAccessSet } from '../../../dataLakeService/narrowLakeAccessToSession';
import { admitSessionLakes, noSessionLakes, searchedSessionLakes } from '../../../dataLakeService/sessionLakeAdmission';
import type { ToolContext } from './types';

/**
 * The lake access a knowledge tool should run on for THIS session: the caller's owner-wide access,
 * narrowed to the session's lake, or nothing at all when the session's corpus is personal or its
 * scope deliberately names no lake.
 *
 * One implementation for every knowledge tool (search, retrieve, count, describe) and both arms of
 * the search tool. They are auto-paired (addPairedTool), so any of them resolving lake access
 * differently reopens the leak on every turn the others are scoped - which is exactly what happened
 * when only one tool honoured the session.
 */
export async function resolveSessionLakeAccess(
  context: ToolContext,
  ownerAccess: () => Promise<ResolvedLakeAccessSet> = () => resolveOwnerLakeAccess(context)
): Promise<ResolvedLakeAccessSet> {
  // Two different reasons for the same answer, and the narrowing below can express neither: it
  // reads an empty scope as "no opinion" and hands back the caller's full owner-wide access.
  if (context.suppressLakeArms) return noSessionLakes();
  if (sessionGroundsOnNoLake(context.sessionRetrievalTags, context.sessionLakeScopeExplicit)) return noSessionLakes();
  return searchedSessionLakes(await ownerAccess(), {
    retrievalTags: context.sessionRetrievalTags,
    lakeScopeExplicit: context.sessionLakeScopeExplicit,
  });
}

/**
 * The caller's owner-wide lake access plus the session's pre-authorized lakes, with no session
 * narrowing: the set resolveSessionLakeAccess narrows from. A caller that needs both (retrieve
 * attributes its chips owner-wide) memoizes this once and passes it in as `ownerAccess`.
 */
export async function resolveOwnerLakeAccess(context: ToolContext): Promise<ResolvedLakeAccessSet> {
  const resolved = await getDynamicDataLakeAccess(context);
  // `context.userId` is the session OWNER on any turn that carries preauthorizedLakeIds:
  // vetPreauthorizedLakeIds blanks the field unless the session's own userId equals the acting
  // user, and the identity-substituting worker paths never reach that call at all.
  return admitSessionLakes(resolved, context.sessionPreauthorizedLakeIds, context.userId, context.db);
}

/**
 * Whether the knowledge tools must leave the caller's own/shared library out of this session's
 * corpus (the "+ My files" chip off). An explicit flag wins; unset excludes only in a session
 * deliberately scoped to a named lake, so derived-tag plain chats and content-tag API sessions keep
 * their library. Forced retrieval decides the same flag in KnowledgeRetrievalFeature. An agent
 * kbScope is already its own fail-closed corpus and is never narrowed here.
 */
export function sessionExcludesLibrary(context: ToolContext): boolean {
  if (context.kbScope) return false;
  const namesALake =
    context.sessionLakeScopeExplicit === true && datalakeTagsFrom(context.sessionRetrievalTags ?? []).length > 0;
  return !effectiveIncludeLibraryFiles(context.sessionIncludeLibraryFiles, namesALake);
}

/** What a knowledge tool says when the library is off and no lake is left to search. */
export const LIBRARY_OFF_NO_LAKE_MESSAGE =
  "No data lake is in this chat's scope and your files are turned off for this chat, so there is nothing to search.";
