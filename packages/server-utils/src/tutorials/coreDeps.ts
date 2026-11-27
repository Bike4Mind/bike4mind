// The main surface's session deps: a tutorial runs in an ordinary notebook the user owns.
import { rescopeUserSubscriptions } from '../websocket/rescopeUserSubscriptions';
import type { TutorialRequest } from './routes/types';
import { isTutorialSessionName, TUTORIAL_SESSION_PREFIX } from '@bike4mind/common';
import {
  fabFileRepository,
  organizationRepository,
  projectRepository,
  sessionAgentConfigRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { sessionService } from '@bike4mind/services';
import { getOrCreateSession } from '../managers/sessionCrud';
import { setCoreSessionMarker } from './sessionMarker';
import { tutorialSheets } from './sheet';
import { CORE_TUTORIAL_SHEET_TAG } from './sheetTags';
import type { TutorialServiceDeps } from './service';

export { CORE_TUTORIAL_SHEET_TAG };

const sheets = tutorialSheets({ tag: CORE_TUTORIAL_SHEET_TAG });

type ShareFields = { isGlobalRead?: boolean; isGlobalWrite?: boolean; users?: unknown[]; groups?: unknown[] };
const isShared = (session: ShareFields) =>
  !!session.isGlobalRead ||
  !!session.isGlobalWrite ||
  (session.users?.length ?? 0) > 0 ||
  (session.groups?.length ?? 0) > 0;

export function coreTutorialDepsFor(req: TutorialRequest): TutorialServiceDeps {
  return {
    ensureSheet: (_userId, module, options) => {
      if (!module.sheet) throw new Error(`Tutorial ${module.id} has no sheet`);
      return sheets.ensure(req, { ...module, sheet: module.sheet }, options);
    },
    createSession: async module => {
      const name = `${TUTORIAL_SESSION_PREFIX}${module.title}`;
      const { sessionId, asyncPromises } = await getOrCreateSession({
        sessionName: name,
        user: req.user!,
        ability: req.ability,
        logger: req.logger,
      });
      // No autoNamePlaceholder: a placeholder name is what makes a notebook eligible for auto-naming
      // (hasAutoNamePlaceholderName), and the badge and the walk's last step both rely on the tutorial name.
      Promise.all(asyncPromises).catch(error => req.logger.warn('tutorial: session side effects failed', error));
      return { id: sessionId };
    },
    // A session moved into a workspace has left the main surface, so the walk no longer owns it.
    ownsSession: async (sessionId, userId) => {
      const session = await sessionRepository.findByIdAndUserId(sessionId, userId);
      return !!session && !session.surface;
    },
    // Only a notebook still carrying the tutorial's name, owned by the user, with nothing attached to it, not shared
    // and in no project.
    deleteSession: async (sessionId, userId) => {
      const session = await sessionRepository.findByIdAndUserId(sessionId, userId);
      if (!session || !isTutorialSessionName(session.name)) return false;
      if (isShared(session) || (session.knowledgeIds?.length ?? 0) > 0) return false;
      if ((await fabFileRepository.find({ sessionId })).length > 0) return false;
      if ((await projectRepository.findAllBySessionId(sessionId)).length > 0) return false;
      const affectedUserIds = await withTransaction(async () => {
        const affected = new Set<string>();
        await sessionService.deleteSession(
          userId,
          { id: sessionId },
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
        return [...affected];
      });
      await rescopeUserSubscriptions(affectedUserIds, req.logger);
      return true;
    },
    setSessionMarker: setCoreSessionMarker,
    warn: message => req.logger.warn(message),
  };
}
