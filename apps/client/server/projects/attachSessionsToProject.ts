import {
  fabFileRepository,
  projectRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import type { Ability } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { ProjectEvents, type ISessionDocument } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';
import { SessionEvents } from '@server/utils/eventBus';
import { filterSessionIdsByOperationalCredits } from '@server/utils/sessionOperationalCreditPreflight';
import { OPERATIONS_PER_SUMMARIZE_WITH_TAGGING } from '@server/utils/sessionOperationCounts';

export interface ProjectMutationContext {
  user: { id: string };
  ability?: Ability;
  logger?: Logger;
}

/**
 * Attaches sessions to a project and queues a summary of each. Shared by POST /api/projects/[id]/sessions
 * and POST /api/v1/projects/{id}/sessions so the two cannot drift. Returns the sessions that resolved.
 */
export async function attachSessionsToProject(
  ctx: ProjectMutationContext,
  projectId: string,
  sessionIds: [string, ...string[]]
): Promise<ISessionDocument[]> {
  const project = await projectService.get(
    ctx.user.id,
    { id: projectId },
    {
      db: {
        projects: projectRepository,
        users: userRepository,
      },
    }
  );

  const sessions = await withTransaction(async () => {
    const user = await userRepository.findById(ctx.user.id);
    if (!user) {
      throw new Error('User not found');
    }
    return projectService.addSessions(
      user,
      {
        projectId,
        sessionIds,
      },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
        },
      }
    );
  });

  // Iterates the RESOLVED sessions rather than the request's raw id list: `addSessions`
  // returns one row per distinct notebook, so the same id sent twice no longer queues (and
  // pays for) two identical summaries.
  // Attaching a notebook to a project is free; only the summary it triggers costs credits, and
  // this fan-out is already best-effort (Promise.allSettled). So a refusal skips the queueing
  // rather than failing the attach, and neither caller's response has room to report it, leaving
  // the warning log as where a skipped summary surfaces (#1852).
  const summarizableSessionIds = await filterSessionIdsByOperationalCredits(sessions, {
    payerId: ctx.user.id,
    operationsPerSession: OPERATIONS_PER_SUMMARIZE_WITH_TAGGING,
    operation: 'session summarization',
    logger: ctx.logger,
  });

  await Promise.allSettled(
    sessions.map(async session => {
      logEvent(
        {
          userId: ctx.user.id,
          type: ProjectEvents.ADD_SESSION,
          metadata: {
            projectId,
            projectName: project.name,
            contentId: session.id,
            contentType: 'session',
          },
        },
        { ability: ctx.ability }
      );
      if (!summarizableSessionIds.has(session.id)) return;
      await SessionEvents.Summarize.publish({
        sessionId: session.id,
        callTagging: true,
        trigger: 'project',
        payerId: ctx.user.id,
      });
    })
  );

  return sessions;
}
