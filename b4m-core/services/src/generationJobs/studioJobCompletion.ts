import {
  STUDIO_COMPLETION_TITLE_MAX_CHARS,
  TERMINAL_GENERATION_JOB_STATES,
  studioCompletionLink,
  type GenerationJobKind,
  type IGenerationJobDocument,
  type IGenerationJobRepository,
  type StudioCompletionMedium,
  type StudioJobCompletedEvent,
} from '@bike4mind/common';

export type StudioJobCompletionDeps = {
  repository: Pick<IGenerationJobRepository, 'findByGroup' | 'claimGroupCompletionNotice'>;
  publish(event: StudioJobCompletedEvent): Promise<void>;
  now(): Date;
};

export type StudioJobCompletionOutcome =
  'emitted' | 'not_studio' | 'group_pending' | 'all_cancelled' | 'already_emitted';

const MEDIUM_BY_KIND: Record<GenerationJobKind, StudioCompletionMedium> = {
  image: 'image',
  video: 'video',
  music: 'music',
};

const UNTITLED = 'Untitled';
const ELLIPSIS = '...';

const isTerminal = (job: IGenerationJobDocument) => TERMINAL_GENERATION_JOB_STATES.includes(job.state);

/** The prompt as a one-line label: whitespace collapsed, cut on a word where one is near the limit. */
export const studioCompletionTitle = (prompt: string | undefined): string => {
  const flat = (prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return UNTITLED;
  if (flat.length <= STUDIO_COMPLETION_TITLE_MAX_CHARS) return flat;
  const room = STUDIO_COMPLETION_TITLE_MAX_CHARS - ELLIPSIS.length;
  const cut = flat.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > room / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}${ELLIPSIS}`;
};

/** An image job's batch, or the job alone for a kind (or an older image job) that has no group. */
const loadGroup = async (
  job: IGenerationJobDocument,
  repository: StudioJobCompletionDeps['repository']
): Promise<{ groupId: string; members: IGenerationJobDocument[]; expected: number }> => {
  if (job.kind !== 'image' || !job.payload.groupId) return { groupId: job.id, members: [job], expected: 1 };
  const members = await repository.findByGroup(job.requestedBy, job.payload.groupId);
  return { groupId: job.payload.groupId, members, expected: job.payload.groupSize ?? members.length };
};

/**
 * Emits `studio.job.completed` once per finished Studio group, from the terminal handling of each of its jobs.
 * Each job's terminal state is committed before this runs, so the last of a group to finish always sees the whole
 * group terminal; when two finish together and both see it, the claim on the group's anchor (lowest id) lets
 * exactly one publish. A group the user cancelled outright is not announced: they already know.
 */
export async function emitStudioJobCompletion(
  job: IGenerationJobDocument,
  deps: StudioJobCompletionDeps
): Promise<StudioJobCompletionOutcome> {
  if (job.source !== 'studio') return 'not_studio';
  const { groupId, members, expected } = await loadGroup(job, deps.repository);
  if (members.length < expected || !members.every(isTerminal)) return 'group_pending';

  const readyCount = members.filter(member => member.state === 'succeeded').length;
  const cancelledCount = members.filter(member => member.state === 'cancelled').length;
  const failedCount = members.length - readyCount - cancelledCount;
  if (readyCount + failedCount === 0) return 'all_cancelled';

  const anchor = members.reduce((lowest, member) => (member.id < lowest.id ? member : lowest));
  const now = deps.now();
  if (!(await deps.repository.claimGroupCompletionNotice(anchor.id, now))) return 'already_emitted';

  const medium = MEDIUM_BY_KIND[job.kind];
  await deps.publish({
    version: 1,
    userId: job.requestedBy,
    groupId,
    medium,
    totalCount: members.length,
    readyCount,
    failedCount,
    cancelledCount,
    title: studioCompletionTitle(anchor.payload.request.prompt),
    link: studioCompletionLink(medium, groupId),
    completedAt: now.toISOString(),
  });
  return 'emitted';
}
