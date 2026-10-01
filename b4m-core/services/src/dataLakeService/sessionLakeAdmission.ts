import type { IDataLakeRepository } from '@bike4mind/common';
import type { ManageRecheckAdapter } from './filterStillManagedLakes';
import {
  narrowLakeAccessToSession,
  sessionGroundsOnNoLake,
  type ResolvedLakeAccessSet,
} from './narrowLakeAccessToSession';
import { unionPreauthorizedLakeAccess } from './unionPreauthorizedLakeAccess';

export const NO_SESSION_LAKES: ResolvedLakeAccessSet = {
  dataLakeTags: [],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: [],
  lakes: [],
  excludedByAccessCount: 0,
};

export interface SessionLakeAdmissionInput {
  retrievalTags?: string[];
  lakeScopeExplicit?: boolean;
  /** Must already be vetted against the acting user (vetPreauthorizedLakeIds). */
  preauthorizedLakeIds?: string[];
}

export interface SessionLakeAdmission {
  /** The caller's access plus the session's still-managed pre-authorizations, before scope narrowing. */
  admitted: ResolvedLakeAccessSet;
  /** What chat's knowledge tools search this turn: `admitted` narrowed to the session's scope. */
  searched: ResolvedLakeAccessSet;
}

/**
 * How a session turns a caller's resolved lake access into the lakes chat searches. The one
 * implementation behind resolveSessionLakeAccess (every knowledge tool) and the session-aware
 * `retrievable` label on GET /api/data-lakes, so the label cannot drift from what chat does.
 */
export async function resolveSessionLakeAdmission(
  access: ResolvedLakeAccessSet,
  session: SessionLakeAdmissionInput,
  actorUserId: string,
  db: { dataLakes?: Pick<IDataLakeRepository, 'findById'> } & ManageRecheckAdapter
): Promise<SessionLakeAdmission> {
  const admitted = await unionPreauthorizedLakeAccess(access, session.preauthorizedLakeIds, actorUserId, db);
  const searched = sessionGroundsOnNoLake(session.retrievalTags, session.lakeScopeExplicit)
    ? NO_SESSION_LAKES
    : narrowLakeAccessToSession(admitted, session.retrievalTags);
  return { admitted, searched };
}
