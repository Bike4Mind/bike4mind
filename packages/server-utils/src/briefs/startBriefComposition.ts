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
  briefs: Pick<
    typeof assistantBriefRepository,
    'findActiveComposing' | 'findLatestReady' | 'createComposing' | 'discardComposing'
  >;
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
  const briefId = brief._id.toString();
  try {
    await deps.publishCompose({ briefId, userId, ...(options.scheduled ? { scheduled: true } : {}) });
  } catch (err) {
    // Drop the row before rethrowing: left composing, it would read as in flight to the retry (the
    // scheduler's, or a second tap) for BRIEF_COMPOSING_STALE_MS while no worker ever composes it.
    await deps.briefs.discardComposing(briefId).catch(() => undefined);
    throw err;
  }
  return brief;
}

export type ScheduledBriefOutcome =
  'enqueued' | 'in_flight' | 'no_activity' | 'push_off' | 'schedule_off' | 'user_missing';

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
 * The scheduled path into the composer: skips users whose schedule is now off, users who turned brief
 * pushes off, and windows with no agent runs (the worker derives approvals from those runs' sessions, so
 * no runs means nothing to report), so none of them costs a model call or leaves a row behind.
 */
export async function startScheduledBrief(
  userId: string,
  deps: ScheduledBriefDeps = defaultScheduledDeps
): Promise<ScheduledBriefOutcome> {
  const user = await deps.users.findById(userId);
  if (!user) return 'user_missing';
  // The reconciler claims the slot before this re-read, so a PUT that just disabled the schedule wins here.
  if (!user.preferences?.briefSchedule?.enabled) return 'schedule_off';
  if (!isPushCategoryEnabled(user.preferences?.pushNotifications, 'brief_ready')) return 'push_off';
  if (await deps.briefs.findActiveComposing(userId, deps.now())) return 'in_flight';

  const latest = await deps.briefs.findLatestReady(userId);
  const { periodStart } = briefWindow(latest?.periodEnd, deps.now());
  if (!(await deps.hasRunsSince(userId, periodStart))) return 'no_activity';

  await startBriefComposition(userId, deps, { scheduled: true });
  return 'enqueued';
}
