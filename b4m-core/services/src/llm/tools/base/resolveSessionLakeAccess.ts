import { getDynamicDataLakeAccess } from '../../../dataLakeService/getDynamicDataLakeTags';
import {
  narrowLakeAccessToSession,
  sessionGroundsOnNoLake,
  type ResolvedLakeAccessSet,
} from '../../../dataLakeService/narrowLakeAccessToSession';
import { unionPreauthorizedLakeAccess } from '../../../dataLakeService/unionPreauthorizedLakeAccess';
import type { ToolContext } from './types';

const NO_LAKES: ResolvedLakeAccessSet = {
  dataLakeTags: [],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: [],
  lakes: [],
};

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
export async function resolveSessionLakeAccess(context: ToolContext): Promise<ResolvedLakeAccessSet> {
  // Two different reasons for the same answer, and the narrowing below can express neither: it
  // reads an empty scope as "no opinion" and hands back the caller's full owner-wide access.
  if (context.suppressLakeArms) return NO_LAKES;
  if (sessionGroundsOnNoLake(context.sessionRetrievalTags, context.sessionLakeScopeExplicit)) return NO_LAKES;
  const resolved = await getDynamicDataLakeAccess(context);
  // `context.userId` is the session OWNER on any turn that carries preauthorizedLakeIds:
  // vetPreauthorizedLakeIds blanks the field unless the session's own userId equals the acting
  // user, and the identity-substituting worker paths never reach that call at all.
  const unioned = await unionPreauthorizedLakeAccess(
    resolved,
    context.sessionPreauthorizedLakeIds,
    context.userId,
    context.db
  );
  return narrowLakeAccessToSession(unioned, context.sessionRetrievalTags);
}
