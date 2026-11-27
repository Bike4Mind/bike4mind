import {
  ConflictError,
  NotFoundError,
  callableFunctionReviewStatus,
  recipientCallableFunction,
  reviewHash,
  toCallableFunctionShared,
  type CallableFunctionAccess,
  type CallableFunctionApprovalMode,
  type FunctionContract,
  type ICallableFunctionDocument,
  type ICallableFunctionReviewDocument,
  type ICallableFunctionShared,
} from '@bike4mind/common';
import { callableFunctionRepository, callableFunctionReviewRepository } from '@bike4mind/database';
import { canCallFunction, displayNamesOf, interfaceChangesSince, reviewedInterface } from './sharing';
import type { CallableFunctionActor } from './registry';

/**
 * A recipient's review of a function shared with them. A review names the live pin's `reviewHash`, which covers the
 * interface (name, description, and schemas) and not the code: a repin with the same interface keeps it, and a
 * changed interface reads as pending again for that person.
 */

const notFound = () => new NotFoundError('Tool not found');

/** Whether `review` is an enabled review of exactly this interface. */
export async function isCurrentReview(
  review: Pick<ICallableFunctionReviewDocument, 'enabled' | 'reviewHash'> | null,
  contract: FunctionContract
): Promise<boolean> {
  return callableFunctionReviewStatus(review, await reviewHash(contract)) === 'reviewed';
}

/** Whether `userId` holds an enabled review of exactly this interface. */
export async function hasCurrentReview(
  userId: string,
  fn: Pick<ICallableFunctionDocument, 'id'> & { contract: FunctionContract }
): Promise<boolean> {
  return isCurrentReview(await callableFunctionReviewRepository.findFor(fn.id, userId), fn.contract);
}

/** Deletes the recipients' reviews of every function `userId` owns, ahead of the erasure that deletes the functions. */
export async function deleteReviewsOfOwnedCallableFunctions(userId: string): Promise<void> {
  const ids = await callableFunctionRepository.listIdsForUser(userId);
  await callableFunctionReviewRepository.deleteForFunctions(ids);
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
  fn: Pick<ICallableFunctionDocument, 'id' | 'ownerType' | 'ownerKey' | 'grants' | 'state' | 'contract'> &
    Partial<Pick<ICallableFunctionDocument, 'promoted'>>,
  options: { headless: boolean }
): Promise<CallableFunctionOffer | null> {
  const access = await canCallFunction(caller, fn);
  if (!access) return null;
  if (access === 'owner') return { access, approval: 'default' };
  const contract = fn.state === 'live' ? fn.contract : fn.promoted?.contract;
  const review = await callableFunctionReviewRepository.findFor(fn.id, caller.id);
  if (!contract || !review || !(await isCurrentReview(review, contract))) return null;
  if (options.headless && review.approval === 'always_ask') return null;
  return { access, approval: review.approval };
}

/** The function as a recipient reads it; another person's function, or the caller's own, reads as not found. */
async function readShared(actor: CallableFunctionActor, id: string) {
  const record = await callableFunctionRepository.findById(id);
  if (!record) throw notFound();
  const access = await canCallFunction(actor, record);
  const fn = recipientCallableFunction(record);
  if (!access || access === 'owner' || !fn) throw notFound();
  return { fn, access, hash: await reviewHash(fn.contract) };
}

async function sharedView(
  fn: ICallableFunctionDocument,
  access: Exclude<CallableFunctionAccess, 'owner'>,
  hash: string,
  userId: string
): Promise<ICallableFunctionShared> {
  const review = await callableFunctionReviewRepository.findFor(fn.id, userId);
  return toCallableFunctionShared(fn, access, {
    ownerName: (await displayNamesOf([fn.userId]))[0]!,
    reviewHash: hash,
    review,
    changes: interfaceChangesSince(review, fn.contract, hash),
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
    reviewed: reviewedInterface(fn.contract),
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
