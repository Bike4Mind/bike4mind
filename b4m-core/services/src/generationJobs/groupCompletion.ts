import {
  TERMINAL_GENERATION_JOB_STATES,
  type IGenerationJobDocument,
  type IGenerationJobRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/** A finished group: the N takes of one "make N" image request, or a video or music job alone. */
export type GroupCompletion = {
  groupId: string;
  /** Every member, terminal, ordered by id. */
  members: IGenerationJobDocument[];
  /** The member that carries the group's claim (its lowest id); its request is the group's request. */
  anchor: IGenerationJobDocument;
  readyCount: number;
  /** Failed or blocked members. Members the user cancelled are counted apart, since they are not a failure. */
  failedCount: number;
  cancelledCount: number;
  completedAt: Date;
};

/**
 * One channel that announces a finished group (the Studio event, a push, a Slack thread). `wants` is asked of the job
 * that finished last; every member of a group shares its source and delivery, so it speaks for the whole group.
 */
export type GroupCompletionSubscriber = {
  name: string;
  wants(job: IGenerationJobDocument): boolean;
  deliver(completion: GroupCompletion): Promise<void>;
};

export type GroupCompletionDeps = {
  repository: Pick<IGenerationJobRepository, 'findByGroup' | 'claimGroupCompletionNotice'>;
  subscribers: readonly GroupCompletionSubscriber[];
  now(): Date;
  logger: Pick<Logger, 'error'>;
};

export type GroupCompletionOutcome =
  'announced' | 'no_audience' | 'group_pending' | 'all_cancelled' | 'already_announced';

const isTerminal = (job: IGenerationJobDocument) => TERMINAL_GENERATION_JOB_STATES.includes(job.state);

/** An image job's batch, or the job alone for a kind (or an older image job) that has no group. */
const loadGroup = async (
  job: IGenerationJobDocument,
  repository: GroupCompletionDeps['repository']
): Promise<{ groupId: string; members: IGenerationJobDocument[]; expected: number }> => {
  if (job.kind !== 'image' || !job.payload.groupId) return { groupId: job.id, members: [job], expected: 1 };
  const members = await repository.findByGroup(job.requestedBy, job.payload.groupId);
  return { groupId: job.payload.groupId, members, expected: job.payload.groupSize ?? members.length };
};

/**
 * The one place that decides a group is finished, run from the terminal handling of each of its jobs, so every channel
 * announces a "make N" batch once rather than once per take. Each job's terminal state is committed before this runs:
 * once the whole group is stored, the last of it to finish sees every member terminal, and when two finish together
 * and both see it, the claim on the anchor lets exactly one announce. At most once: a channel that fails after the
 * claim is logged, not retried, and does not stop the others. A group the user cancelled outright is not announced:
 * they already know.
 */
export async function announceGroupCompletion(
  job: IGenerationJobDocument,
  deps: GroupCompletionDeps
): Promise<GroupCompletionOutcome> {
  const audience = deps.subscribers.filter(subscriber => subscriber.wants(job));
  if (audience.length === 0) return 'no_audience';

  const { groupId, members, expected } = await loadGroup(job, deps.repository);
  if (members.length < expected || !members.every(isTerminal)) return 'group_pending';

  const readyCount = members.filter(member => member.state === 'succeeded').length;
  const cancelledCount = members.filter(member => member.state === 'cancelled').length;
  const failedCount = members.length - readyCount - cancelledCount;
  if (readyCount + failedCount === 0) return 'all_cancelled';

  const ordered = [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const anchor = ordered[0];
  const completedAt = deps.now();
  if (!(await deps.repository.claimGroupCompletionNotice(anchor.id, completedAt))) return 'already_announced';

  const completion: GroupCompletion = {
    groupId,
    members: ordered,
    anchor,
    readyCount,
    failedCount,
    cancelledCount,
    completedAt,
  };
  const results = await Promise.allSettled(audience.map(subscriber => subscriber.deliver(completion)));
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    // The group is already claimed, so this channel's notice is lost; the log is the only trace of it.
    deps.logger.error('group completion delivery failed', {
      channel: audience[index].name,
      groupId,
      jobId: job.id,
      error: result.reason,
    });
  });
  return 'announced';
}
