import {
  ConflictError,
  NotFoundError,
  reviewHash,
  toCallableFunctionShared,
  type CallableFunctionAccess,
  type CallableFunctionApprovalMode,
  type FunctionContract,
  type ICallableFunctionDocument,
  type ICallableFunctionShared,
} from '@bike4mind/common';
import { callableFunctionRepository, callableFunctionReviewRepository } from '@bike4mind/database';
import { canCallFunction, displayNamesOf } from './sharing';
import type { CallableFunctionActor } from './registry';

/**
 * A recipient's review of a function shared with them. A review names the live pin's `reviewHash`, which covers the
 * interface (name, description, and schemas) and not the code: a repin with the same interface keeps it, and a
 * changed interface reads as pending again for that person.
 */

const notFound = () => new NotFoundError('Tool not found');

/** Whether `userId` holds an enabled review of exactly this interface. */
export async function hasCurrentReview(
  userId: string,
  fn: Pick<ICallableFunctionDocument, 'id'> & { contract: FunctionContract }
): Promise<boolean> {
  const review = await callableFunctionReviewRepository.findFor(fn.id, userId);
  return review !== null && review.enabled && review.reviewHash === (await reviewHash(fn.contract));
}

export interface CallableFunctionOffer {
  access: CallableFunctionAccess;
  approval: CallableFunctionApprovalMode;
}

/**
 * Whether a chat or agent turn may offer `fn` to `caller`, and with whose approval mode: the owner always (their
 * own mode applies through their surface); a recipient only with a current, enabled review, under the recipient's
 * mode, and never an `always_ask` function in a headless turn, where no one can answer the card.
 */
export async function callableFunctionOffer(
  caller: { id: string },
  fn: Pick<ICallableFunctionDocument, 'id' | 'ownerType' | 'ownerKey' | 'grants' | 'state' | 'contract'>,
  options: { headless: boolean }
): Promise<CallableFunctionOffer | null> {
  const access = await canCallFunction(caller, fn);
  if (!access) return null;
  if (access === 'owner') return { access, approval: 'default' };
  const review = await callableFunctionReviewRepository.findFor(fn.id, caller.id);
  if (!review || !review.enabled || review.reviewHash !== (await reviewHash(fn.contract))) return null;
  if (options.headless && review.approval === 'always_ask') return null;
  return { access, approval: review.approval };
}

/** The function as a recipient reads it; another person's function, or the caller's own, reads as not found. */
async function readShared(actor: CallableFunctionActor, id: string) {
  const fn = await callableFunctionRepository.findById(id);
  if (!fn) throw notFound();
  const access = await canCallFunction(actor, fn);
  if (!access || access === 'owner') throw notFound();
  return { fn, access, hash: await reviewHash(fn.contract) };
}

async function sharedView(
  fn: ICallableFunctionDocument,
  access: Exclude<CallableFunctionAccess, 'owner'>,
  hash: string,
  userId: string
): Promise<ICallableFunctionShared> {
  return toCallableFunctionShared(fn, access, {
    ownerName: (await displayNamesOf([fn.userId]))[0]!,
    reviewHash: hash,
    review: await callableFunctionReviewRepository.findFor(fn.id, userId),
  });
}

/**
 * Records the caller's review of the interface they read. `reviewedHash` is the hash they were shown, so an
 * interface that changed since is refused rather than approved unseen.
 */
export async function reviewSharedCallableFunction(
  actor: CallableFunctionActor,
  id: string,
  input: { reviewHash: string; approval: CallableFunctionApprovalMode }
): Promise<ICallableFunctionShared> {
  const { fn, access, hash } = await readShared(actor, id);
  if (input.reviewHash !== hash) {
    throw new ConflictError('The tool changed while you were reviewing it. Review it again.', {
      code: 'review_conflict',
    });
  }
  await callableFunctionReviewRepository.saveReview({
    functionId: fn.id,
    userId: actor.id,
    reviewHash: hash,
    approval: input.approval,
  });
  return sharedView(fn, access, hash, actor.id);
}

/** Changes the caller's approval mode, or turns the function off or back on, without reviewing it again. */
export async function updateSharedCallableFunctionReview(
  actor: CallableFunctionActor,
  id: string,
  settings: { approval?: CallableFunctionApprovalMode; enabled?: boolean }
): Promise<ICallableFunctionShared> {
  const { fn, access, hash } = await readShared(actor, id);
  const saved = await callableFunctionReviewRepository.updateSettings(fn.id, actor.id, settings);
  if (!saved) {
    throw new ConflictError('Review the tool before changing how it runs.', { code: 'not_reviewed' });
  }
  return sharedView(fn, access, hash, actor.id);
}
