import { BadRequestError } from '@bike4mind/utils';
import { workItemRepository } from '@bike4mind/database';

/**
 * Authorize and sanity-check a proposed `dependencies` list before it is
 * written. Every id must resolve to a live work item the caller owns (IDOR
 * protection plus referential integrity), and the resulting graph must stay
 * acyclic - a cycle would leave every item in it permanently un-ready.
 *
 * `itemId` is omitted on create, where the item has no id yet.
 */
export async function assertDependenciesUsable(userId: string, dependencies: string[], itemId?: string): Promise<void> {
  if (dependencies.length === 0) return;

  if (itemId && dependencies.includes(itemId)) {
    throw new BadRequestError('A work item cannot depend on itself');
  }

  const found = await workItemRepository.findManyByIdsForUser(dependencies, userId);
  if (found.length !== dependencies.length) {
    const foundIds = new Set(found.map(item => item.id));
    const missing = dependencies.filter(id => !foundIds.has(id));
    throw new BadRequestError(`Unknown work item dependencies: ${missing.join(', ')}`);
  }

  if (await workItemRepository.detectDependencyCycle(userId, dependencies, itemId)) {
    throw new BadRequestError('Those dependencies would create a cycle');
  }
}
