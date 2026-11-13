import type { IWorkItem, WorkItemPriority } from '../types/entities/WorkItemTypes';
import { workItemPriorityRank } from '../types/entities/WorkItemTypes';

/** `createdAt` may be an ISO string: Desktop stores tickets as JSON. */
type Created = { createdAt: Date | string };
type Pickable = Pick<IWorkItem, 'id' | 'status' | 'stage' | 'priority' | 'dependencies'> & Created;

/**
 * A loop's ready tickets in the order its scheduler takes them: open, triaged, not in the last stage, every
 * dependency closed (one `depStatus` does not know counts as closed: it was deleted). Sorted by priority, then
 * later stage first (finish work before starting more), then oldest. Must stay in sync with
 * WorkItemRepository.listReady (packages/database/src/models/ai/WorkItemModel.ts); Desktop loops use this one.
 */
export function pickReady<T extends Pickable>(
  tickets: T[],
  stages: string[],
  depStatus: (id: string) => IWorkItem['status'] | undefined,
  onlyPriorities?: WorkItemPriority[]
): T[] {
  const last = stages.at(-1);
  const stageIndex = (ticket: T) => stages.indexOf(ticket.stage ?? '');
  return tickets
    .filter(
      ticket =>
        ticket.status === 'open' &&
        ticket.priority !== undefined &&
        ticket.stage !== last &&
        (!onlyPriorities || onlyPriorities.includes(ticket.priority)) &&
        ticket.dependencies.every(id => {
          const status = depStatus(id);
          return status === undefined || status === 'closed';
        })
    )
    .sort(
      (a, b) =>
        workItemPriorityRank(a.priority) - workItemPriorityRank(b.priority) ||
        stageIndex(b) - stageIndex(a) ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
}

/** Open tickets with no priority yet, oldest first: a triage run sets theirs. An epic waits on its children instead. */
export const untriaged = <T extends Pick<IWorkItem, 'status' | 'priority' | 'epic'> & Created>(tickets: T[]): T[] =>
  tickets
    .filter(ticket => ticket.status === 'open' && ticket.priority === undefined && !ticket.epic)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
