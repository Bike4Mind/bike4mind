// The main surface's session deps: a tutorial runs in an ordinary notebook the user owns.
import type { Request } from 'express';
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
import { getOrCreateSession } from '@server/managers/sessionCrud';
import { tutorialSheets } from './sheet';
import type { TutorialServiceDeps } from './service';

/** Names the user's sheet copies; the overlay keeps its own tag, so the two never touch each other's files. */
export const CORE_TUTORIAL_SHEET_TAG = 'tutorial';

const sheets = tutorialSheets({ tag: CORE_TUTORIAL_SHEET_TAG });

export function coreTutorialDepsFor(req: Request): TutorialServiceDeps {
  return {
    ensureSheet: (_userId, module, options) => {
      if (!module.sheet) throw new Error(`Tutorial ${module.id} has no sheet`);
      return sheets.ensure(req, { ...module, sheet: module.sheet }, options);
    },
    createSession: async module => {
      const name = `${TUTORIAL_SESSION_PREFIX}${module.title}`;
      const { session, sessionId, asyncPromises } = await getOrCreateSession({
        sessionName: name,
        user: req.user!,
        ability: req.ability,
        logger: req.logger,
      });
      // Held on the name it was born with, so auto-naming leaves the sidebar badge alone until the user renames it.
      await sessionRepository.update({ id: session.id, autoNamePlaceholder: name });
      Promise.all(asyncPromises).catch(error => req.logger.warn('tutorial: session side effects failed', error));
      return { id: sessionId };
    },
    // A session moved into a workspace has left the main surface, so the walk no longer owns it.
    ownsSession: async (sessionId, userId) => {
      const session = await sessionRepository.findByIdAndUserId(sessionId, userId);
      return !!session && !session.surface;
    },
    // Only a notebook still carrying the tutorial's name, owned by the user, with nothing attached to it.
    deleteSession: async (sessionId, userId) => {
      const session = await sessionRepository.findByIdAndUserId(sessionId, userId);
      if (!session || !isTutorialSessionName(session.name)) return false;
      if ((await fabFileRepository.find({ sessionId })).length > 0) return false;
      await withTransaction(() =>
        sessionService.deleteSession(
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
          }
        )
      );
      return true;
    },
    setSessionMarker: async (sessionId, userId, moduleId) => {
      if (!(await sessionRepository.findByIdAndUserId(sessionId, userId))) return;
      await sessionRepository.update({ id: sessionId, tutorial: moduleId ? { owner: 'core', moduleId } : null });
    },
    warn: message => req.logger.warn(message),
  };
}
