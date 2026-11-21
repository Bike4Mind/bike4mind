import { isPushCategoryEnabled } from '@bike4mind/common';
import {
  agentExecutionRepository,
  assistantBriefRepository,
  userRepository,
  type IAssistantBrief,
} from '@bike4mind/database';
import { BRIEF_MAX_WINDOW_MS, BRIEF_MIN_GAP_MS, SCHEDULED_BRIEF_MIN_GAP_MS, briefWindow } from './briefSchedule';
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
  runs: Pick<typeof agentExecutionRepository, 'findEarliestStraddlingRunCreatedAt'>;
  publishCompose: (event: { briefId: string; userId: string; scheduled?: boolean }) => Promise<unknown>;
  now: () => Date;
};

const defaultDeps: Deps = {
  briefs: assistantBriefRepository,
  runs: agentExecutionRepository,
  publishCompose: publishBriefCompose,
  now: () => new Date(),
};

/**
 * briefWindow, moved back to the creation of the earliest run that was still going at the window's start,
 * so a run that finishes after the last brief is reported. The composer lists runs by createdAt only
 * (loadActivity in apps/workers/src/events/briefCompose.ts), so runs finished inside the widened part
 * are listed again.
 */
async function activityWindow(userId: string, deps: Deps, now: Date): Promise<{ periodStart: Date; periodEnd: Date }> {
  const latest = await deps.briefs.findLatestReady(userId);
  const window = briefWindow(latest?.periodEnd, now);
  const straddling = await deps.runs.findEarliestStraddlingRunCreatedAt(
    userId,
    window.periodStart,
    new Date(now.getTime() - BRIEF_MAX_WINDOW_MS)
  );
  return straddling ? { ...window, periodStart: straddling } : window;
}

async function beginComposition(
  userId: string,
  deps: Deps,
  options: { scheduled?: boolean }
): Promise<{ brief: IAssistantBrief; created: boolean }> {
  const inFlight = await deps.briefs.findActiveComposing(userId, deps.now());
  if (inFlight) return { brief: inFlight, created: false };

  const { periodStart, periodEnd } = await activityWindow(userId, deps, deps.now());

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
  return { brief, created: true };
}

/**
 * Reuses a recent composing brief on retry. The window runs from the end of the last ready brief,
 * capped at a week; stale composing rows retain the existing five-minute recovery window.
 */
export async function startBriefComposition(
  userId: string,
  deps: Deps = defaultDeps,
  options: { scheduled?: boolean } = {}
): Promise<IAssistantBrief> {
  return (await beginComposition(userId, deps, options)).brief;
}

export type ScheduledBriefOutcome =
  'debounced' | 'enqueued' | 'in_flight' | 'no_activity' | 'push_off' | 'schedule_off' | 'user_missing';

export type ScheduledBriefDeps = Deps & {
  users: Pick<typeof userRepository, 'findById' | 'claimBriefStart' | 'releaseBriefStart'>;
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
 * The automatic path into the composer, shared by the schedule and agent-run completion: skips users whose
 * schedule is off, users who turned brief pushes off, and windows with no agent runs (the worker derives
 * approvals from those runs' sessions, so no runs means nothing to report), so none of them costs a model
 * call or leaves a row behind. Then claims the per-user debounce, needing `claimGapMs` since the last claim
 * of either path, so concurrent starts collapse into one brief.
 */
async function startGatedBrief(
  userId: string,
  deps: ScheduledBriefDeps,
  claimGapMs: number
): Promise<ScheduledBriefOutcome> {
  const user = await deps.users.findById(userId);
  if (!user) return 'user_missing';
  // The reconciler claims the slot before this re-read, so a PUT that just disabled the schedule wins here.
  if (!user.preferences?.briefSchedule?.enabled) return 'schedule_off';
  if (!isPushCategoryEnabled(user.preferences?.pushNotifications, 'brief_ready')) return 'push_off';
  const now = deps.now();
  if (await deps.briefs.findActiveComposing(userId, now)) return 'in_flight';

  const { periodStart } = await activityWindow(userId, deps, now);
  if (!(await deps.hasRunsSince(userId, periodStart))) return 'no_activity';

  const claim = await deps.users.claimBriefStart(userId, now, claimGapMs);
  if (!claim) return 'debounced';
  const release = () =>
    deps.users.releaseBriefStart(userId, now, claim.previous).catch((releaseError: unknown) => {
      logger.error('Failed to release a brief start claim', { userId, releaseError });
    });
  let created: boolean;
  try {
    ({ created } = await beginComposition(userId, deps, { scheduled: true }));
  } catch (err) {
    // Keep the claim only when the compose event may have been delivered.
    if (!(err instanceof BriefComposeStartError && !err.retrySafe)) await release();
    throw err;
  }
  // A composition started elsewhere (an on-demand POST) between the in-flight check and here.
  if (!created) {
    await release();
    return 'in_flight';
  }
  return 'enqueued';
}

export function startScheduledBrief(
  userId: string,
  deps: ScheduledBriefDeps = defaultScheduledDeps
): Promise<ScheduledBriefOutcome> {
  return startGatedBrief(userId, deps, SCHEDULED_BRIEF_MIN_GAP_MS);
}

/** Starts a brief when an agent run completes, under the schedule's gates, at most once per BRIEF_MIN_GAP_MS. */
export function startEventBrief(
  userId: string,
  deps: ScheduledBriefDeps = defaultScheduledDeps
): Promise<ScheduledBriefOutcome> {
  return startGatedBrief(userId, deps, BRIEF_MIN_GAP_MS);
}
