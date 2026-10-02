import type { IDataLakeRepository } from '@bike4mind/common';
import type { ManageRecheckAdapter } from './filterStillManagedLakes';
import {
  narrowLakeAccessToSession,
  sessionGroundsOnNoLake,
  type ResolvedLakeAccessSet,
} from './narrowLakeAccessToSession';
import { unionPreauthorizedLakeAccess } from './unionPreauthorizedLakeAccess';

/** A factory, not a shared constant: callers receive mutable arrays. */
export const noSessionLakes = (): ResolvedLakeAccessSet => ({
  dataLakeTags: [],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: [],
  lakes: [],
  excludedByAccessCount: 0,
});

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
  const admitted = await admitSessionLakes(access, session.preauthorizedLakeIds, actorUserId, db);
  return { admitted, searched: searchedSessionLakes(admitted, session) };
}

/** The `admitted` half of resolveSessionLakeAdmission, for a caller that memoizes it separately. */
export function admitSessionLakes(
  access: ResolvedLakeAccessSet,
  preauthorizedLakeIds: string[] | undefined,
  actorUserId: string,
  db: { dataLakes?: Pick<IDataLakeRepository, 'findById'> } & ManageRecheckAdapter
): Promise<ResolvedLakeAccessSet> {
  return unionPreauthorizedLakeAccess(access, preauthorizedLakeIds, actorUserId, db);
}

/** The `searched` half of resolveSessionLakeAdmission: an admitted set narrowed to the session's scope. */
export function searchedSessionLakes(
  admitted: ResolvedLakeAccessSet,
  session: Pick<SessionLakeAdmissionInput, 'retrievalTags' | 'lakeScopeExplicit'>
): ResolvedLakeAccessSet {
  return sessionGroundsOnNoLake(session.retrievalTags, session.lakeScopeExplicit)
    ? noSessionLakes()
    : narrowLakeAccessToSession(admitted, session.retrievalTags);
}
