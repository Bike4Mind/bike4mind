import {
  SessionEvents,
  redactSessionForClient,
  sessionDeleteContract,
  sessionGetContract,
  sessionUpdateContract,
} from '@bike4mind/common';
import { sessionService } from '@bike4mind/services';
import {
  projectRepository,
  sessionRepository,
  userRepository,
  organizationRepository,
  fabFileRepository,
  sessionAgentConfigRepository,
  withTransaction,
} from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { buildSessionUpdateAdapters } from '@server/sessions/sessionUpdateAdapters';
import { unpublishUserArtifactsBySource } from '@bike4mind/server-utils/services/publish/purgeUserPublishedArtifacts';
import { purgeDeletedNotebookMedia } from '@bike4mind/server-utils/sessions/purgeDeletedNotebookMedia';
import { rescopeUserSubscriptions } from '@server/websocket/rescopeUserSubscriptions';
import { readSession } from '@server/sessions/readSession';

// Each verb's auth mode, required scope, and path/body validation come from its contract
// (sessionGetContract, sessionUpdateContract, sessionDeleteContract), the single source of truth
// that also drives the OpenAPI spec. `req.validated` / `req.validatedParams` are the parsed body/id.
const getHandler = nextRouteForContract(sessionGetContract).get(readSession);

const deleteHandler = nextRouteForContract(sessionDeleteContract).delete(async (req, res) => {
  const { id } = req.validatedParams;
  const userId = req.user!.id;
  // deleteSession rewrites grant rows across every file this session touched before it tombstones
  // anything, and takes a version-guarded write on each. Without a transaction a
  // ConcurrencyConflictError partway through leaves some files rewritten and some not, with the
  // session still live. Matches the revokeSharing route, which wraps the sibling cascade for the
  // same reason; the service's own ordering comment already assumes a retry sees an all-or-nothing
  // state. That all-or-nothing is what sessionDeleteContract's 409 promises.
  const { newLastNotebook, affectedUserIds } = await withTransaction(async () => {
    const affected = new Set<string>();
    const newLastNotebook = await sessionService.deleteSession(
      userId,
      { id },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
          users: userRepository,
          organizations: organizationRepository,
          sessionAgentConfigs: sessionAgentConfigRepository,
        },
        logger: req.logger,
        onAccessRemoved: ids => ids.forEach(id => affected.add(id)),
      }
    );
    return { newLastNotebook, affectedUserIds: [...affected] };
  });
  await rescopeUserSubscriptions(affectedUserIds, req.logger);

  // Published replies are snapshots that outlive their notebook; take the owner's down with it, as
  // the bulk DELETE /api/sessions does. After the delete, so a refused or conflicting one keeps them.
  // The delete is already committed, so a failure is logged rather than failing the request.
  try {
    await unpublishUserArtifactsBySource(userId, { kind: 'reply', sessionIds: [id] }, { logger: req.logger });
  } catch (error) {
    req.logger.error('Error unpublishing replies after session delete:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: id,
      userId,
    });
  }

  await purgeDeletedNotebookMedia([id], { logger: req.logger });

  await logEvent({ userId, type: SessionEvents.DELETE_SESSION, metadata: { sessionId: id } }, { ability: req.ability });

  return res.json({ newLastNotebookId: newLastNotebook?.id ?? null });
});

// PUT used to be unscoped: any valid API key could call it (undocumented), including
// narrow-purpose ones like CC_BRIDGE/EMBED_CHAT that were never meant to write to sessions.
// See sessionUpdateContract's `scopes` comment for why that changed.
const putHandler = nextRouteForContract(sessionUpdateContract).put(async (req, res) => {
  const { id } = req.validatedParams;

  const updatedSession = await sessionService.updateSession(
    req.user!,
    { ...req.validated, id },
    buildSessionUpdateAdapters(req, req.user!, req.logger)
  );

  await logEvent(
    {
      userId: req.user.id,
      type: SessionEvents.UPDATE_SESSION,
      metadata: {
        sessionId: id,
        sessionName: updatedSession.name,
        knowledgeIds: updatedSession.knowledgeIds ?? [],
        agentIds: updatedSession.agentIds ?? [],
      },
    },
    { ability: req.ability }
  );

  return res.json(redactSessionForClient(updatedSession));
});

// nextRouteForContract refuses any verb its contract does not declare, so each verb has its own
// router; any other verb gets the path-level 405 the contracts document (see dispatchByMethod).
export default dispatchByMethod({ GET: getHandler, PUT: putHandler, DELETE: deleteHandler });

export const config = {
  api: {
    externalResolver: true,
  },
};
