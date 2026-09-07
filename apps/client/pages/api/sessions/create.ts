import { sessionService, dataLakeService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
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
import {
  SessionEvents,
  ProjectEvents,
  redactSessionForClient,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '@bike4mind/common';
import { projectService } from '@bike4mind/services';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { ActivityType } from '@client/config/activities';
import { CreateSessionRequestBody } from '../../../types/api';

/** See the cap check in the handler - bounds a sequential, two-reads-per-id authorization loop. */
const MAX_PREAUTHORIZED_LAKES = 10;

interface CreateSessionBody {
  projectId?: string;
  [key: string]: any;
}

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const body = req.body as CreateSessionBody;
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
    // round-trips. Capped here at the raw body rather than in the zod request schema, which this
    // route never parses. The real admission is one lake ("test this lake"); the headroom is for a
    // maintainer arming a handful at once.
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
        // "no such lake" answer as the miss below, so give it the same 404 - this route parses no
        // zod schema, so nothing upstream has checked the shape.
        if (!isValidObjectId(lakeId)) {
          throw new NotFoundError(`Data lake ${lakeId} not found`);
        }
        // A key that widens the caller's own manage rights would otherwise let a leaked API key
        // reach every lake its minting user manages, not just the lakes the key was bound to at
        // mint time. This is IN ADDITION to the canManageLake check below, never instead of it - the
        // key binding narrows what the underlying user's authority may be used for, it never grants
        // authority the user lacks.
        if (req.apiKeyInfo && !req.apiKeyInfo.preauthorizedLakeIds?.includes(lakeId)) {
          throw new ForbiddenError(`This API key is not bound to data lake ${lakeId}`);
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
    let createParams: CreateSessionRequestBody = body as CreateSessionRequestBody;
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

    const newSession = await sessionService.createSession(req.user, createParams, {
      db: {
        sessions: sessionRepository,
        projects: projectRepository,
        fabFiles: fabFileRepository,
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
    });

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
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
