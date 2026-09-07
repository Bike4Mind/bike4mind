import { getDynamicDataLakeAccess } from '../../../dataLakeService/getDynamicDataLakeTags';
import {
  narrowLakeAccessToSession,
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
 * narrowed to the session's lake, or nothing at all when the session's corpus is personal.
 *
 * One implementation for all three tools and both arms of the search tool. They are auto-paired
 * (addPairedTool), so any of them resolving lake access differently reopens the leak on every turn
 * the others are scoped - which is exactly what happened when only one tool honoured the session.
 */
export async function resolveSessionLakeAccess(context: ToolContext): Promise<ResolvedLakeAccessSet> {
  if (context.suppressLakeArms) return NO_LAKES;
  const resolved = await getDynamicDataLakeAccess(context);
  // `context.userId` is the session OWNER on any turn that carries preauthorizedLakeIds - the field
  // is only populated after vetPreauthorizedLakeIds matches the session owner to the request's
  // authenticated principal, and is left unset where there is no principal to vet against.
  const unioned = await unionPreauthorizedLakeAccess(
    resolved,
    context.sessionPreauthorizedLakeIds,
    context.userId,
    context.db
  );
  return narrowLakeAccessToSession(unioned, context.sessionRetrievalTags);
}
