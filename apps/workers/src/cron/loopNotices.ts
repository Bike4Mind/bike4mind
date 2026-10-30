import { InboxType, loopStatusNeedsOwner, type ILoop, type IWorkItem, type LoopStatus } from '@bike4mind/common';
import { inboxRepository, loopRepository, usableObjectIds, workItemRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';

const KEY_PREFIX = 'loop:';
const TITLE_CHARS = 120;
const MESSAGE_CHARS = 1000;

const STATUS_TITLES: Partial<Record<LoopStatus, string>> = {
  needs_you: 'needs you',
  error: 'stopped with an error',
  paused: 'paused',
};

export interface LoopNotice {
  sourceKey: string;
  receiverId: string;
  title: string;
  message: string;
  link: string;
}

type BlockedTicket = Pick<IWorkItem, 'id' | 'loopId' | 'title' | 'statusReason' | 'executionId'>;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/**
 * The notices that should be open right now: one per loop whose status needs its owner
 * (`loopStatusNeedsOwner`, shared with the loop list marker) and one per blocked ticket of a loop
 * that still exists. The status is part of the key, so `paused` -> `error` replaces the notice.
 */
export function desiredLoopNotices(
  loops: ILoop[],
  tickets: BlockedTicket[],
  loopsById: Map<string, ILoop>
): LoopNotice[] {
  const notices: LoopNotice[] = loops.filter(loopStatusNeedsOwner).map(loop => ({
    sourceKey: `${KEY_PREFIX}${loop.id}:status:${loop.status}`,
    receiverId: loop.userId,
    title: clip(`Loop "${loop.name}" ${STATUS_TITLES[loop.status]}`, TITLE_CHARS),
    message: clip(
      `${loop.statusReason ?? 'The loop stopped.'}\nOpen the loop and set it live again once fixed.`,
      MESSAGE_CHARS
    ),
    link: `/loops/${loop.id}`,
  }));

  for (const ticket of tickets) {
    const loop = loopsById.get(ticket.loopId!);
    if (!loop) continue;
    notices.push({
      sourceKey: `${KEY_PREFIX}${loop.id}:ticket:${ticket.id}`,
      receiverId: loop.userId,
      title: clip(`Loop "${loop.name}": ticket blocked - ${ticket.title}`, TITLE_CHARS),
      message: clip(
        `${ticket.statusReason ?? 'Blocked.'}\nOpen the loop, sort it out, then unblock or close the ticket.`,
        MESSAGE_CHARS
      ),
      link: ticket.executionId ? `/loops/${loop.id}?run=${ticket.executionId}` : `/loops/${loop.id}`,
    });
  }
  return notices;
}

/**
 * Reconciles the owner inbox with loop state: opens a notice for every desired key that has none and
 * resolves every keyed `loop:` notice no longer desired (loop live again, ticket unblocked, closed or
 * deleted, loop deleted). Idempotent per tick; the inbox's unique `sourceKey` index dedupes overlapping
 * ticks. A changed reason on an unchanged key does not re-notify, and a notice the owner deleted keeps its
 * key (so is not re-sent) until its cause clears.
 *
 * ponytail: global scan of candidate loops and blocked loop tickets every tick; go per-user or
 * event-driven if loop counts grow.
 */
export async function syncLoopNotices(logger: Logger): Promise<void> {
  const [candidates, tickets, held] = await Promise.all([
    loopRepository.find({ status: { $in: ['needs_you', 'error', 'paused'] } }),
    workItemRepository.find({ loopId: { $exists: true }, deletedAt: null, status: 'blocked' }),
    inboxRepository.listKeyed(KEY_PREFIX),
  ]);
  const loopsById = new Map(candidates.map(loop => [loop.id, loop]));
  const missing = [...new Set(tickets.map(ticket => ticket.loopId!))].filter(id => !loopsById.has(id));
  const loopIds = usableObjectIds(missing, 'loopNotices', logger);
  if (loopIds.length > 0) {
    for (const loop of await loopRepository.find({ _id: { $in: loopIds } })) loopsById.set(loop.id, loop);
  }

  const desired = desiredLoopNotices(candidates, tickets, loopsById);
  const desiredKeys = new Set(desired.map(notice => notice.sourceKey));
  const heldKeys = new Set(held.map(notice => notice.sourceKey));

  let created = 0;
  for (const notice of desired) {
    if (heldKeys.has(notice.sourceKey)) continue;
    if (await inboxRepository.createKeyedNotice({ ...notice, userId: 'SYSTEM', type: InboxType.LOOP })) created++;
  }
  const stale = held.filter(notice => !desiredKeys.has(notice.sourceKey)).map(notice => notice.id);
  await inboxRepository.resolveKeyed(stale);

  if (created > 0 || stale.length > 0) {
    logger.info(`[Loops] Notices: ${created} opened, ${stale.length} resolved`);
  }
}
