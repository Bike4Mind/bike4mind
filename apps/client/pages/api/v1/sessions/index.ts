import { sessionService, dataLakeService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { UnprocessableEntityError } from '@server/utils/errors';
import {
  agentRepository,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  fabFileRepository,
  fallbackLakeSettingsRepository,
  organizationRepository,
  projectRepository,
  sessionRepository,
  userRepository,
  User,
  activityRepository,
} from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { isValidObjectId } from '@server/utils/objectId';
import { resolveSessionOrigin } from '@server/managers/sessionOrigin';
import {
  SessionEvents,
  ProjectEvents,
  redactSessionForClient,
  createSessionContract,
  listSessionsContract,
  type ISessionDocument,
  type SessionResponse,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  canUseSurface,
  getWorkspaceSurface,
} from '@bike4mind/common';
import { surfaceAccessForRequest } from '@server/entitlements/surfaceAccess';
import { projectService } from '@bike4mind/services';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { ActivityType } from '@client/config/activities';
import { CreateSessionRequestBody } from '../../../../types/api';

/** See the cap check in the handler - bounds a sequential, two-reads-per-id authorization loop. */
const MAX_PREAUTHORIZED_LAKES = 10;

// Exported for the legacy POST /api/sessions/create alias, which must not also answer GET.
export const createSessionRouter = nextRouteForContract(createSessionContract).post(async (req, res) => {
  const userId = req.user.id;
  const body = req.validated;
  const { projectId } = body;

  // corpusGroundingMode is resolved server-side from the lake (resolveLakeSessionDefaults) whenever
  // a lake is named, never client-supplied for one: strip it unconditionally when `dataLakeId` is
  // set so a lake editor's deliberate per-lake mode always wins the merge below. The one caller
  // trusted to set it directly is a session that names a lake ONLY by `retrievalTags` (no
  // `dataLakeId`) - e.g. "test this lake" - where there is no later lake-defaults merge to be
  // overridden and the mode is the caller's own choice of what to test. An ordinary non-lake
  // session (neither field set) still has it stripped, leaving no mode (size-only behavior).
  const namesALakeByTagsOnly = !body.dataLakeId && Array.isArray(body.retrievalTags) && body.retrievalTags.length > 0;
  if (!namesALakeByTagsOnly) {
    delete body.corpusGroundingMode;
  }

  // Only REGISTERED surfaces are entitlement-checked. Private modules create sessions under surface
  // strings this repo does not register (see surfaces.ts) and rely on that write passing through as
  // it always has, so an unknown surface is deliberately left alone here.
  if (
    body.surface &&
    getWorkspaceSurface(body.surface) &&
    !canUseSurface(await surfaceAccessForRequest(req)(), body.surface)
  ) {
    throw new ForbiddenError('You do not have access to that workspace');
  }

  // Manage-but-not-member admission: a lake maintainer who is not a member of the lake's org (or
  // does not otherwise pass the ordinary tag/entitlement gate) can still test it, for exactly this
  // session, if they manage it. Authorize here - never let it ride through createSession's own
  // input, so no other caller of that service (fork/snip/clone, the Slack handlers, ...) can ever
  // pass it through by construction. Written onto the session as a separate call AFTER creation.
  const requestedPreauthorizedLakeIds = Array.isArray(body.preauthorizedLakeIds)
    ? Array.from(new Set(body.preauthorizedLakeIds.filter((id): id is string => typeof id === 'string')))
    : undefined;
  delete body.preauthorizedLakeIds;

  // Bound the authorization loop below: it is SEQUENTIAL and costs two indexed reads per id
  // (findById + the grant read), so an unbounded list turns one request into thousands of
  // round-trips. Capped here rather than in the zod request schema, which keeps the field loose.
  // The real admission is one lake ("test this lake"); the headroom is for a maintainer arming a
  // handful at once.
  if (requestedPreauthorizedLakeIds && requestedPreauthorizedLakeIds.length > MAX_PREAUTHORIZED_LAKES) {
    throw new BadRequestError(`At most ${MAX_PREAUTHORIZED_LAKES} pre-authorized data lakes per session`);
  }

  let preauthorizedLakeIds: string[] | undefined;
  if (requestedPreauthorizedLakeIds && requestedPreauthorizedLakeIds.length > 0) {
    // Rung 1 (isAdmin) deliberately excluded: this must be "the maintainer who manages THIS lake",
    // not "any platform admin" - see canManageLake's rung table. administeredOrgIds is re-resolved
    // here rather than read off toAccessContext because that helper zeroes it for admin actors
    // (org resolution is skipped as a pure-overhead optimization for the ordinary read gates it
    // serves), which would silently reject an admin whose only relationship to the lake is
    // org-admin.
    const manageActor = {
      userId: req.user.id,
      isAdmin: false,
      administeredOrgIds: await organizationRepository.findIdsWithAdminRights(req.user.id),
    };
    for (const lakeId of requestedPreauthorizedLakeIds) {
      // A malformed id would reach Mongoose as a CastError and surface as a 500. It is the same
      // "no such lake" answer as the miss below, so give it the same 404 - the request schema
      // leaves the array untyped, so nothing upstream has checked the shape.
      if (!isValidObjectId(lakeId)) {
        throw new NotFoundError(`Data lake ${lakeId} not found`);
      }
      // A key that widens the caller's own manage rights would otherwise let a leaked API key
      // reach every lake its minting user manages, not just the lakes the key was bound to at
      // mint time. This is IN ADDITION to the canManageLake check below, never instead of it - the
      // key binding narrows what the underlying user's authority may be used for, it never grants
      // authority the user lacks.
      if (req.apiKeyInfo && !req.apiKeyInfo.preauthorizedLakeIds?.includes(lakeId)) {
        // Names where the binding comes from: it is set at mint time by an administrator and
        // cannot be added to an existing key, so a caller reading only "not bound" has no way to
        // tell whether they are meant to fix it themselves (#2945).
        throw new ForbiddenError(
          `This API key is not bound to data lake ${lakeId}. Lake bindings are set when the key is ` +
            `minted, by an administrator, and cannot be added to an existing key - ask an admin to ` +
            `issue a key bound to this lake.`
        );
      }
      const lake = await dataLakeRepository.findById(lakeId);
      if (!lake || lake.status !== 'active') {
        throw new NotFoundError(`Data lake ${lakeId} not found`);
      }
      const canManage = await dataLakeService.resolveCanManageLake(lake, manageActor, {
        db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
      });
      if (!canManage) {
        throw new ForbiddenError(`You do not manage data lake ${lakeId}`);
      }
    }
    preauthorizedLakeIds = requestedPreauthorizedLakeIds;
  }

  // "Start chat with this lake": when the request names a lake, seed the session's
  // lake-derived defaults (forced retrieval scoped to the lake + its preferred prompt id) from
  // the ONE reusable resolver. Gated on `dataLakeId` so ordinary session creation does zero
  // extra work and stays byte-identical. The lake is access-gated first (assertLakeAccess) so a
  // caller can never arm a lake's prompt for a lake they cannot reach. Explicit request values
  // win over the lake defaults for systemPromptId/retrievalTags (a hand-set value beats the lake),
  // but corpusGroundingMode is stripped above, so the lake is always authoritative for it.
  let createParams = body as CreateSessionRequestBody;
  if (body.dataLakeId) {
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(String(body.dataLakeId), ctx, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        // Merges a static lake's admin-set groundingMode override in, so resolveLakeSessionDefaults
        // below (which reads `lake.groundingMode` off this return value) actually sees it.
        fallbackLakeSettings: fallbackLakeSettingsRepository,
      },
    });
    const lakeDefaults = sessionService.resolveLakeSessionDefaults(lake);
    createParams = { ...lakeDefaults, ...body } as CreateSessionRequestBody;
  }

  const newSession = await sessionService.createSession(
    req.user,
    createParams,
    {
      db: {
        sessions: sessionRepository,
        projects: projectRepository,
        fabFiles: fabFileRepository,
        agents: agentRepository,
      },
      logger: req.logger,
      // See the update route: the ownership reader cannot see a lake-membership file, so without
      // this a session started from a teammate's org-lake file derives no scope at all.
      //
      // Imported at CALL time, not module load: the resolver's dependency graph reaches the Mongoose
      // models, which pulls schema construction into the import graph of every consumer of this
      // route. It is only needed when files are actually attached, so paying for it lazily keeps the
      // route's static imports as they were.
      resolveLakeAccess: async () =>
        (await import('@server/dataLakes/resolveRetrievalLakeScope')).resolveRetrievalLakeScope(req),
      // The attachment door's lake arms, so a supplied lake file passes the access check.
      resolveAttachmentLakeAccess: async () =>
        (await import('@server/queueHandlers/agentExecutor.attachmentLakeAccess')).createAttachmentLakeAccess(
          req.user,
          req.logger
        )(),
    },
    { origin: resolveSessionOrigin(req) }
  );

  // Separate, authorized write - never part of createSession's own params (see above). The
  // in-memory mutation keeps `newSession` faithful to the record for any later reader in this
  // handler; it is NOT what keeps the response honest - `preauthorizedLakeIds` is in
  // SERVER_OWNED_SESSION_FIELDS, so redactSessionForClient strips it either way, and the
  // CREATE_SESSION log line does not carry the field at all.
  if (preauthorizedLakeIds) {
    const updated = await sessionRepository.update({ id: newSession.id, preauthorizedLakeIds });
    if (updated) newSession.preauthorizedLakeIds = updated.preauthorizedLakeIds;
  }

  await User.findByIdAndUpdate(userId, { lastNotebookId: newSession.id });

  const asyncPromises = [];
  asyncPromises.push(
    logEvent(
      {
        userId,
        type: SessionEvents.CREATE_SESSION,
        metadata: {
          sessionId: newSession.id,
          sessionName: newSession.name,
          knowledgeIds: newSession.knowledgeIds ?? [],
          agentIds: newSession.agentIds ?? [],
        },
      },
      { ability: req.ability }
    )
  );

  if (projectId) {
    const project = await projectService.get(
      userId,
      { id: projectId },
      {
        db: {
          projects: projectRepository,
          users: userRepository,
        },
      }
    );

    asyncPromises.push(
      logEvent(
        {
          userId,
          type: ProjectEvents.ADD_SESSION,
          metadata: {
            projectId,
            projectName: project.name,
            contentId: newSession.id,
            contentType: 'session',
          },
        },
        { ability: req.ability }
      )
    );

    asyncPromises.push(
      activityRepository.createActivity(
        ActivityType.NOTEBOOK_ADDED_TO_PROJECT,
        { type: 'Project', id: projectId },
        { type: 'User', id: userId }
      )
    );
  }
  await Promise.all(asyncPromises);

  // Redact server-owned fields (e.g. systemPromptText) from the client response
  return res.json(redactSessionForClient(newSession));
});

const LIST_CURSOR_SCOPE = 'v1.sessions';

/**
 * Explicit allowlist onto the public SessionResponse shape. Redaction already strips the
 * server-owned fields; the allowlist additionally keeps every undocumented internal field off
 * the wire, so a new ISession field is private until someone adds it here and to the schema.
 */
function toPublicSession(session: ISessionDocument): SessionResponse {
  const redacted = redactSessionForClient(session);
  return {
    id: redacted.id,
    _id: redacted.id,
    name: redacted.name,
    userId: redacted.userId,
    knowledgeIds: redacted.knowledgeIds,
    artifactIds: redacted.artifactIds,
    tags: redacted.tags?.map(({ name, strength }) => ({ name, strength })),
    forceKnowledgeRetrieval: redacted.forceKnowledgeRetrieval,
    retrievalTags: redacted.retrievalTags,
    lakeScopeExplicit: redacted.lakeScopeExplicit,
    lastUsedModel: redacted.lastUsedModel,
    firstCreated: redacted.firstCreated,
    lastUpdated: redacted.lastUpdated,
  };
}

// Lists only the caller's OWN sessions (userId match); shared sessions stay on the SPA's
// GET /api/sessions/shared. Paged by _id rather than lastUpdated: lastUpdated moves on every edit,
// which would skip or repeat rows across pages.
const listSessionsRouter = nextRouteForContract(listSessionsContract, {
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const { limit, cursor, search, surface, origin } = req.validatedQuery;
  const beforeId = cursor === undefined ? undefined : decodeCursor(cursor, LIST_CURSOR_SCOPE);
  // A decoded id is client-controlled; keep a malformed one away from Mongo.
  if (beforeId !== undefined && !isValidObjectId(beforeId)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }
  // One extra row tells whether another page exists without a count query.
  const rows = await sessionRepository.listByUserId({
    userId: req.user.id,
    search,
    surface,
    filters: origin ? { origin } : undefined,
    beforeId,
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(LIST_CURSOR_SCOPE, page[page.length - 1].id) : null;
  return res.json({ data: page.map(toPublicSession), next_cursor: nextCursor });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ GET: listSessionsRouter, POST: createSessionRouter });
