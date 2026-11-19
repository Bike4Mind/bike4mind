import { isPushCategoryEnabled } from '@bike4mind/common';
import {
  agentExecutionRepository,
  assistantBriefRepository,
  EMAIL_TRIAGE_KINDS,
  emailTriageItemRepository,
  userRepository,
  type IAssistantBrief,
} from '@bike4mind/database';
import { BRIEF_MIN_GAP_MS, briefWindow } from './briefSchedule';
import { BriefComposeRejectedError, publishBriefCompose } from './publishBriefCompose';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'startBriefComposition' } });

export class BriefComposeStartError extends Error {
  constructor(
    readonly briefId: string,
    readonly retrySafe: boolean,
    cause: unknown
  ) {
    super('Brief composition event submission failed', { cause });
    this.name = 'BriefComposeStartError';
  }
}

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
  publishCompose: publishBriefCompose,
  now: () => new Date(),
};

/**
 * Reuses a recent composing brief on retry. The window runs from the end of the last ready brief,
 * capped at a week; stale composing rows retain the existing five-minute recovery window.
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
    let retrySafe = false;
    if (err instanceof BriefComposeRejectedError) {
      try {
        retrySafe = await deps.briefs.discardComposing(briefId);
      } catch (cleanupError) {
        logger.error('Failed to discard a rejected brief composition', { briefId, cleanupError });
      }
      if (!retrySafe) logger.warn('Rejected brief retained because cleanup was not confirmed', { briefId });
    }
    throw new BriefComposeStartError(briefId, retrySafe, err);
  }
  return brief;
}

export type ScheduledBriefOutcome =
  'debounced' | 'enqueued' | 'in_flight' | 'no_activity' | 'push_off' | 'schedule_off' | 'user_missing';

export type ScheduledBriefDeps = Deps & {
  users: Pick<typeof userRepository, 'findById' | 'claimBriefStart' | 'releaseBriefStart'>;
  /** Whether the user started any agent run at or after `since`. */
  hasRunsSince(userId: string, since: Date): Promise<boolean>;
  /** Whether the user has triaged email not yet briefed as of `end`; unwindowed, like the composer's load. */
  hasPendingEmails(userId: string, end: Date): Promise<boolean>;
};

const defaultScheduledDeps: ScheduledBriefDeps = {
  ...defaultDeps,
  users: userRepository,
  hasRunsSince: async (userId, since) => {
    const { items } = await agentExecutionRepository.findByUserIdPaginated(userId, { fromDate: since }, { limit: 1 });
    return items.length > 0;
  },
  hasPendingEmails: async (userId, end) => {
    const sections = await Promise.all(
      EMAIL_TRIAGE_KINDS.map(kind => emailTriageItemRepository.listPending(userId, end, 1, kind))
    );
    return sections.some(items => items.length > 0);
  },
};

/**
 * The automatic path into the composer, shared by the schedule and agent-run completion: skips users whose
 * schedule is off, users who turned brief pushes off, and windows with no agent runs and no pending triaged
 * email (the worker derives approvals and questions from the runs' sessions, so those two are its only
 * activity sources), so none of them costs a model call or leaves a row behind. Then claims the per-user
 * debounce so the two paths start one brief per gap.
 */
async function startGatedBrief(userId: string, deps: ScheduledBriefDeps): Promise<ScheduledBriefOutcome> {
  const user = await deps.users.findById(userId);
  if (!user) return 'user_missing';
  // The reconciler claims the slot before this re-read, so a PUT that just disabled the schedule wins here.
  if (!user.preferences?.briefSchedule?.enabled) return 'schedule_off';
  if (!isPushCategoryEnabled(user.preferences?.pushNotifications, 'brief_ready')) return 'push_off';
  const now = deps.now();
  if (await deps.briefs.findActiveComposing(userId, now)) return 'in_flight';

  const latest = await deps.briefs.findLatestReady(userId);
  const { periodStart, periodEnd } = briefWindow(latest?.periodEnd, now);
  const [hasRuns, hasEmails] = await Promise.all([
    deps.hasRunsSince(userId, periodStart),
    deps.hasPendingEmails(userId, periodEnd),
  ]);
  if (!hasRuns && !hasEmails) return 'no_activity';

  if (!(await deps.users.claimBriefStart(userId, now, BRIEF_MIN_GAP_MS))) return 'debounced';
  try {
    await startBriefComposition(userId, deps, { scheduled: true });
  } catch (err) {
    // Same rule as the reconciler's slot retry: keep the claim only when the event may have been delivered.
    if (!(err instanceof BriefComposeStartError && !err.retrySafe)) {
      await deps.users.releaseBriefStart(userId, now).catch((releaseError: unknown) => {
        logger.error('Failed to release a brief start claim', { userId, releaseError });
      });
    }
    throw err;
  }
  return 'enqueued';
}

export function startScheduledBrief(
  userId: string,
  deps: ScheduledBriefDeps = defaultScheduledDeps
): Promise<ScheduledBriefOutcome> {
  return startGatedBrief(userId, deps);
}

/** Starts a brief when an agent run completes, under the same gates and debounce as the schedule. */
export function startEventBrief(
  userId: string,
  deps: ScheduledBriefDeps = defaultScheduledDeps
): Promise<ScheduledBriefOutcome> {
  return startGatedBrief(userId, deps);
}
