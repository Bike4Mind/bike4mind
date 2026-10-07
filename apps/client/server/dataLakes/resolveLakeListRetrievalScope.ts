import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  organizationRepository,
  sessionRepository,
} from '@bike4mind/database';
import { isValidObjectId } from '@server/utils/objectId';
import { resolveRetrievalLakeScope, type RetrievalLakeScope } from './resolveRetrievalLakeScope';

/**
 * The scope GET /api/data-lakes labels `retrievable` against: the caller's chat retrieval scope
 * (no static-registry bypass, as on a chat turn) and, for one of the caller's OWN sessions, that
 * session's admissions via the same resolveSessionLakeAdmission chat's knowledge tools run.
 *
 * Uses the pre-narrowing `admitted` set: the explorer's selection IS the session scope
 * (lakeIdsForTags over retrievalTags), so for a selected lake the two agree, and narrowing would
 * only mark every unselected lake unsearchable. A missing, malformed or foreign session id is
 * indistinguishable from no session in the response.
 */
export async function resolveLakeListRetrievalScope(
  req: Parameters<typeof resolveRetrievalLakeScope>[0],
  rawSessionId: unknown
): Promise<RetrievalLakeScope> {
  const userId = req.user!.id;
  const [scope, session] = await Promise.all([
    resolveRetrievalLakeScope(req, { staticRegistryBypass: false }),
    findOwnSession(rawSessionId, userId),
  ]);
  return session ? admitSessionLakes(scope, session, userId) : scope;
}

type ListSession = NonNullable<Awaited<ReturnType<typeof sessionRepository.findByIdAndUserId>>>;

export function findOwnSession(rawSessionId: unknown, userId: string): Promise<ListSession | null> {
  if (typeof rawSessionId !== 'string' || !isValidObjectId(rawSessionId)) return Promise.resolve(null);
  return sessionRepository.findByIdAndUserId(rawSessionId, userId);
}

export async function admitSessionLakes(
  scope: RetrievalLakeScope,
  session: Pick<ListSession, 'userId' | 'retrievalTags' | 'lakeScopeExplicit' | 'preauthorizedLakeIds'>,
  userId: string
): Promise<RetrievalLakeScope> {
  const { admitted } = await dataLakeService.resolveSessionLakeAdmission(
    scope,
    {
      retrievalTags: session.retrievalTags,
      lakeScopeExplicit: session.lakeScopeExplicit,
      preauthorizedLakeIds: dataLakeService.vetPreauthorizedLakeIds(session, userId),
    },
    userId,
    {
      dataLakes: dataLakeRepository,
      dataLakeAccessGrants: dataLakeAccessGrantRepository,
      organizations: organizationRepository,
    }
  );
  return admitted;
}
