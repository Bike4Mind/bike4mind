import {
  BadGatewayError,
  NotFoundError,
  UnprocessableEntityError,
  type DelegationCreateRequest,
} from '@bike4mind/common';
import { delegatedItemRepository, fabFileRepository, type IDelegatedItem } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { DelegationEvents } from '@bike4mind/server-utils/utils/eventBus';

type Deps = {
  items: Pick<typeof delegatedItemRepository, 'create' | 'markFailed'>;
  /** Live files with these ids; another user's file is filtered out by the caller below. */
  findFiles: (ids: string[]) => Promise<{ id: string; userId?: unknown }[]>;
  publishProcess: (event: { delegationId: string; userId: string }) => Promise<unknown>;
  now: () => Date;
};

const logger = new Logger({ metadata: { service: 'delegations' } });

const defaultDeps: Deps = {
  items: delegatedItemRepository,
  findFiles: ids => fabFileRepository.findAllByIds(ids),
  // requireAcceptance: on self-host an unqueued event must fail the request too, not leave the item pending.
  publishProcess: event => DelegationEvents.Process.publish(event, { requireAcceptance: true }),
  now: () => new Date(),
};

/**
 * Stores the delegated item as `pending` and hands it to apps/workers/src/events/delegationProcess.ts.
 * Every referenced file must be the caller's own live file; anything else is a 404, so file ids cannot be probed.
 */
export async function createDelegation(
  userId: string,
  body: DelegationCreateRequest,
  deps: Deps = defaultDeps
): Promise<IDelegatedItem> {
  const fileIds = [...new Set(body.file_ids ?? [])];
  // Whitespace-only text shares nothing, so it counts as absent.
  const text = body.text?.trim() ? body.text : null;
  if (!body.url && !text && fileIds.length === 0) {
    throw new UnprocessableEntityError('Send at least one of url, text or file_ids');
  }

  if (fileIds.length > 0) {
    const owned = new Set(
      (await deps.findFiles(fileIds)).filter(file => String(file.userId) === userId).map(file => file.id)
    );
    if (fileIds.some(id => !owned.has(id))) throw new NotFoundError('File not found');
  }

  const item = await deps.items.create({
    userId,
    intent: body.intent.trim(),
    url: body.url ?? null,
    text,
    fileIds,
  });
  const delegationId = item._id.toString();
  try {
    await deps.publishProcess({ delegationId, userId });
  } catch (error) {
    logger.error('[Delegation] could not publish the process event', { delegationId, error });
    await deps.items.markFailed(delegationId, 'dispatch_failed', deps.now());
    throw new BadGatewayError('Could not hand the item to the assistant; try again');
  }
  return item;
}
