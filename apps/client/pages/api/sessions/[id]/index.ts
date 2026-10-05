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
  fabFileRepository,
  cacheRepository,
  sessionAgentConfigRepository,
  withTransaction,
} from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { logEvent } from '@server/utils/analyticsLog';
import { getFilesStorage } from '@server/utils/storage';

const getHandler = nextRouteForContract(sessionGetContract).get(async (req, res) => {
  const session = await sessionService.getSession(
    req.user!.id,
    { id: req.validatedParams.id },
    { db: { sessions: sessionRepository, users: userRepository } }
  );

  return res.json(redactSessionForClient(session));
});

const deleteHandler = nextRouteForContract(sessionDeleteContract).delete(async (req, res) => {
  const { id } = req.validatedParams;
  const userId = req.user!.id;
  // deleteSession rewrites grant rows across every file this session touched before it tombstones
  // anything, and takes a version-guarded write on each. Without a transaction a
  // ConcurrencyConflictError partway through leaves some files rewritten and some not, with the
  // session still live. Matches the revokeSharing route, which wraps the sibling cascade for the
  // same reason; the service's own ordering comment already assumes a retry sees an all-or-nothing
  // state. That all-or-nothing is what sessionDeleteContract's 409 promises.
  const newLastNotebook = await withTransaction(() =>
    sessionService.deleteSession(
      userId,
      { id },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
          users: userRepository,
          sessionAgentConfigs: sessionAgentConfigRepository,
        },
        logger: req.logger,
      }
    )
  );

  await logEvent({ userId, type: SessionEvents.DELETE_SESSION, metadata: { sessionId: id } }, { ability: req.ability });

  return res.json({ newLastNotebookId: newLastNotebook?.id || null });
});

// Auth mode, required scope, and request/path-param validation come from sessionUpdateContract
// (the single source of truth also driving the OpenAPI spec). `req.validated` /
// `req.validatedParams` are the parsed, typed body/id. This is a deliberate behavior change
// from the endpoint's pre-PR unscoped state: any valid API key could previously call this
// (undocumented), including narrow-purpose ones like CC_BRIDGE/EMBED_CHAT that were never
// meant to write to sessions - see sessionUpdateContract's `scopes` comment for why.
const putHandler = nextRouteForContract(sessionUpdateContract).put(async (req, res) => {
  const { id } = req.validatedParams;

  const updatedSession = await sessionService.updateSession(
    req.user!,
    { ...req.validated, id },
    {
      db: {
        sessions: sessionRepository,
        projects: projectRepository,
        fabFiles: fabFileRepository,
        caches: cacheRepository,
      },
      logger: req.logger,
      // Lets the lake-tag derivation see lake-membership files: the ownership reader alone cannot,
      // so attaching a teammate's org-lake file would otherwise derive nothing and leave the
      // session unscoped. Same resolver the chat tool runs on, so the two cannot drift.
      // Imported at CALL time - see the create route for why (the resolver's graph reaches the
      // Mongoose models, and it is only needed when files are actually attached).
      resolveLakeAccess: async () =>
        (await import('@server/dataLakes/resolveRetrievalLakeScope')).resolveRetrievalLakeScope(req),
      // The attachment door's lake arms, so an added lake file passes the access check.
      resolveAttachmentLakeAccess: async () =>
        (await import('@server/queueHandlers/agentExecutor.attachmentLakeAccess')).createAttachmentLakeAccess(
          req.user!,
          req.logger
        )(),
      storage: getFilesStorage(),
    }
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
