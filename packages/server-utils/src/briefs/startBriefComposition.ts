import { isPushCategoryEnabled } from '@bike4mind/common';
import {
  agentExecutionRepository,
  assistantBriefRepository,
  EMAIL_TRIAGE_KINDS,
  emailTriageItemRepository,
  userRepository,
  type BusyBlockInterval,
  type IAssistantBrief,
} from '@bike4mind/database';
import { BRIEF_MAX_WINDOW_MS, BRIEF_MIN_GAP_MS, SCHEDULED_BRIEF_MIN_GAP_MS, briefWindow } from './briefSchedule';
import { notifyHeldBlockRuns } from './notifyHeldBlockRuns';
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

/**
 * A busy block's window: its end, and its start moved back to the creation of the earliest run that was
 * still going when the block began, so a run started before the block and finished in it is listed.
 */
async function blockWindow(
  userId: string,
  deps: Deps,
  block: BusyBlockInterval
): Promise<{ periodStart: Date; periodEnd: Date }> {
  const straddling = await deps.runs.findEarliestStraddlingRunCreatedAt(
    userId,
    block.start,
    new Date(block.start.getTime() - BRIEF_MAX_WINDOW_MS)
  );
  return { periodStart: straddling ?? block.start, periodEnd: block.end };
}

type CompositionOptions = {
  scheduled?: boolean;
  /** An explicit window that replaces activityWindow; set together with `busyBlock` for a block brief. */
  window?: { periodStart: Date; periodEnd: Date };
  busyBlock?: BusyBlockInterval;
};

/** Publishes the compose event; a rejected publish discards the row so a retry starts clean. */
async function publishOrDiscard(
  brief: IAssistantBrief,
  deps: Pick<Deps, 'briefs' | 'publishCompose'>,
  event: { userId: string; scheduled?: boolean }
): Promise<void> {
  const briefId = brief._id.toString();
  try {
    await deps.publishCompose({ briefId, ...event });
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
}

async function beginComposition(
  userId: string,
  deps: Deps,
  options: CompositionOptions
): Promise<{ brief: IAssistantBrief; created: boolean }> {
  const inFlight = await deps.briefs.findActiveComposing(userId, deps.now());
  if (inFlight) return { brief: inFlight, created: false };

  const { periodStart, periodEnd } = options.window ?? (await activityWindow(userId, deps, deps.now()));

  const brief = await deps.briefs.createComposing({
    userId,
    periodStart,
    periodEnd,
    ...(options.busyBlock && { trigger: 'busy_block' as const, busyBlock: options.busyBlock }),
  });
  await publishOrDiscard(brief, deps, { userId, ...(options.scheduled ? { scheduled: true } : {}) });
  return { brief, created: true };
}

/**
 * Reuses a recent composing brief on retry. The window runs from the end of the last ready brief,
 * capped at a week; stale composing rows retain the existing five-minute recovery window.
 */
export async function startBriefComposition(
  userId: string,
  deps: Deps = defaultDeps,
  options: CompositionOptions = {}
): Promise<IAssistantBrief> {
  return (await beginComposition(userId, deps, options)).brief;
}

/**
 * Starts a follow-up brief composed from a dictated memo. Never reuses an in-flight brief and never touches the
 * activity window: the memo is stored on the owner's row (cleared on settle), never in the event payload.
 */
export async function startFollowUpComposition(
  userId: string,
  input: { transcript: string; timeZone?: string },
  deps: Pick<Deps, 'briefs' | 'publishCompose' | 'now'> = defaultDeps
): Promise<IAssistantBrief> {
  const now = deps.now();
  const brief = await deps.briefs.createComposing({
    userId,
    periodStart: now,
    periodEnd: now,
    origin: 'followUp',
    followUpInput: { transcript: input.transcript, ...(input.timeZone && { timeZone: input.timeZone }) },
  });
  await publishOrDiscard(brief, deps, { userId });
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
  /** Whether an approved reminder is due at `now` and no brief has listed it yet. */
  hasDueReminders(userId: string, now: Date): Promise<boolean>;
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
  hasDueReminders: async (userId, now) => (await assistantBriefRepository.findDueReminders(userId, now, 1)).length > 0,
};

/**
 * The automatic path into the composer, shared by the schedule and agent-run completion: skips users whose
 * schedule is off, users who turned brief pushes off, and windows with no agent runs, no pending triaged
 * email and no due reminder (the worker derives approvals and questions from the runs' sessions, so those two are its only
 * activity sources), so none of them costs a model call or leaves a row behind. Then claims the per-user
 * debounce, needing `claimGapMs` since the last claim of either path, so concurrent starts collapse into one brief.
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

  const { periodStart, periodEnd } = await activityWindow(userId, deps, now);
  const [hasRuns, hasEmails, hasReminders] = await Promise.all([
    deps.hasRunsSince(userId, periodStart),
    deps.hasPendingEmails(userId, periodEnd),
    deps.hasDueReminders(userId, now),
  ]);
  if (!hasRuns && !hasEmails && !hasReminders) return 'no_activity';

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

export type BlockBriefOutcome = 'busy_off' | 'enqueued' | 'in_flight' | 'no_activity' | 'push_off' | 'user_missing';

export type BlockBriefDeps = Deps & {
  users: Pick<typeof userRepository, 'findById'>;
  /** Whether the user started any agent run in `[start, end]`. */
  hasRunsBetween(userId: string, start: Date, end: Date): Promise<boolean>;
  /** Whether triaged email not yet briefed arrived in `[start, end)`. */
  hasEmailsBetween(userId: string, start: Date, end: Date): Promise<boolean>;
  /** Sends the summary for runs whose pushes the block held, when no block brief will report them. */
  notifyHeldRuns(userId: string, block: BusyBlockInterval): Promise<void>;
};

const defaultBlockDeps: BlockBriefDeps = {
  ...defaultDeps,
  users: userRepository,
  hasRunsBetween: async (userId, start, end) => {
    const { items } = await agentExecutionRepository.findByUserIdPaginated(
      userId,
      { fromDate: start, toDate: end },
      { limit: 1 }
    );
    return items.length > 0;
  },
  hasEmailsBetween: async (userId, start, end) => {
    const sections = await Promise.all(
      EMAIL_TRIAGE_KINDS.map(kind => emailTriageItemRepository.listPending(userId, end, 1, kind, start))
    );
    return sections.some(items => items.length > 0);
  },
  notifyHeldRuns: (userId, block) => notifyHeldBlockRuns(userId, block),
};

/**
 * Starts the brief for one ended busy block, covering email that arrived during it and runs created from the
 * block start, or from the earliest run still going at block start (so runs created after that one are
 * listed too, even ones that finished before the block). Skips users who turned
 * the opt-in or brief pushes off and blocks with no runs and no triaged email. No debounce claim: the
 * caller's per-block claim on `nextBlockBriefAt` is the idempotency. Published as scheduled, so the
 * composer drops a brief that comes out empty or cannot be paid for.
 */
export async function startBlockBrief(
  userId: string,
  block: BusyBlockInterval,
  deps: BlockBriefDeps = defaultBlockDeps
): Promise<BlockBriefOutcome> {
  const user = await deps.users.findById(userId);
  if (!user) return 'user_missing';
  // sendPush holds nothing while the opt-in is off, so there is nothing to summarize.
  if (user.preferences?.busyBlockBrief?.enabled !== true) return 'busy_off';
  if (!isPushCategoryEnabled(user.preferences?.pushNotifications, 'brief_ready')) return 'push_off';
  if (await deps.briefs.findActiveComposing(userId, deps.now())) return 'in_flight';

  const window = await blockWindow(userId, deps, block);
  const [hasRuns, hasEmails] = await Promise.all([
    deps.hasRunsBetween(userId, window.periodStart, window.periodEnd),
    deps.hasEmailsBetween(userId, block.start, block.end),
  ]);
  // A run created before the straddle lookback can still finish in the block with its push held.
  if (!hasRuns && !hasEmails) {
    await deps.notifyHeldRuns(userId, block);
    return 'no_activity';
  }

  const { created } = await beginComposition(userId, deps, { scheduled: true, window, busyBlock: block });
  return created ? 'enqueued' : 'in_flight';
}
