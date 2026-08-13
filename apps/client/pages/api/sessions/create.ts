import { sessionService, dataLakeService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  dataLakeRepository,
  fabFileRepository,
  projectRepository,
  sessionRepository,
  userRepository,
  User,
  activityRepository,
} from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { SessionEvents, ProjectEvents, redactSessionForClient } from '@bike4mind/common';
import { projectService } from '@bike4mind/services';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { ActivityType } from '@client/config/activities';
import { CreateSessionRequestBody } from '../../../types/api';

interface CreateSessionBody {
  projectId?: string;
  [key: string]: any;
}

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const body = req.body as CreateSessionBody;
    const { projectId } = body;

    // corpusGroundingMode is resolved server-side from the lake (resolveLakeSessionDefaults), never
    // client-supplied. Strip any value a hand-built body carries BEFORE the merge below, so it can
    // neither override a lake editor's deliberate per-lake mode (body would otherwise win the spread)
    // nor pin a mode on an ordinary non-lake session and switch off size-based deferral there. The
    // lake arm re-sets it from the lake; a non-lake session is left with no mode (size-only behavior).
    delete body.corpusGroundingMode;

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
        db: { dataLakes: dataLakeRepository },
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
    });

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
