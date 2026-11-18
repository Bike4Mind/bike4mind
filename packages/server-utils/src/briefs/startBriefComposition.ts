import { isPushCategoryEnabled } from '@bike4mind/common';
import {
  agentExecutionRepository,
  assistantBriefRepository,
  userRepository,
  type IAssistantBrief,
} from '@bike4mind/database';
import { briefWindow } from './briefSchedule';
import { BriefEvents } from '../utils/eventBus';

type Deps = {
  briefs: Pick<typeof assistantBriefRepository, 'findActiveComposing' | 'findLatestReady' | 'createComposing'>;
  publishCompose: (event: { briefId: string; userId: string; scheduled?: boolean }) => Promise<unknown>;
  now: () => Date;
};

const defaultDeps: Deps = {
  briefs: assistantBriefRepository,
  publishCompose: event => BriefEvents.Compose.publish(event),
  now: () => new Date(),
};

/**
 * Starts a brief for the user, or returns the one already composing so a double tap (or a retry) never
 * spends a second model call. The window runs from the end of the last ready brief, capped at a week.
 */
export async function startBriefComposition(
  userId: string,
  deps: Deps = defaultDeps,
  options: { scheduled?: boolean } = {}
): Promise<IAssistantBrief> {
  const inFlight = await deps.briefs.findActiveComposing(userId, deps.now());
  if (inFlight) return inFlight;

  const latest = await deps.briefs.findLatestReady(userId);
  const { periodStart, periodEnd } = briefWindow(latest?.periodEnd, deps.now());

  const brief = await deps.briefs.createComposing({ userId, periodStart, periodEnd });
  await deps.publishCompose({
    briefId: brief._id.toString(),
    userId,
    ...(options.scheduled ? { scheduled: true } : {}),
  });
  return brief;
}

export type ScheduledBriefOutcome = 'enqueued' | 'in_flight' | 'no_activity' | 'push_off' | 'user_missing';

export type ScheduledBriefDeps = Deps & {
  users: Pick<typeof userRepository, 'findById'>;
  /** Whether the user started any agent run at or after `since`. */
  hasRunsSince(userId: string, since: Date): Promise<boolean>;
};

const defaultScheduledDeps: ScheduledBriefDeps = {
  ...defaultDeps,
  users: userRepository,
  hasRunsSince: async (userId, since) => {
    const { items } = await agentExecutionRepository.findByUserIdPaginated(userId, { fromDate: since }, { limit: 1 });
    return items.length > 0;
  },
};

/**
 * The scheduled path into the composer: skips users who turned brief pushes off and windows with no agent
 * runs (the worker derives approvals from those runs' sessions, so no runs means nothing to report), so
 * neither costs a model call or leaves a row behind.
 */
export async function startScheduledBrief(
  userId: string,
  deps: ScheduledBriefDeps = defaultScheduledDeps
): Promise<ScheduledBriefOutcome> {
  const user = await deps.users.findById(userId);
  if (!user) return 'user_missing';
  if (!isPushCategoryEnabled(user.preferences?.pushNotifications, 'brief_ready')) return 'push_off';
  if (await deps.briefs.findActiveComposing(userId, deps.now())) return 'in_flight';

  const latest = await deps.briefs.findLatestReady(userId);
  const { periodStart } = briefWindow(latest?.periodEnd, deps.now());
  if (!(await deps.hasRunsSince(userId, periodStart))) return 'no_activity';

  await startBriefComposition(userId, deps, { scheduled: true });
  return 'enqueued';
}
