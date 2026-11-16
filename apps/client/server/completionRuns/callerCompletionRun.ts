import { CreditHolderType, NotFoundError, RUN_NOT_FOUND_ERROR_CODE } from '@bike4mind/common';
import { completionRunRepository, type CompletionRunOwnerType, type ICompletionRun } from '@bike4mind/database';

/** Who is calling a completion-run route: the user, and the organization an org-billed API key draws on. */
export type CompletionRunCaller = { userId: string; billingOrganizationId?: string };

/**
 * The billing owner a caller's runs are bound to: an org-billed key's organization, otherwise the user.
 * The same owner the completions route charges, so a run's attribution and its charges agree.
 */
export function completionRunOwnerOf(caller: CompletionRunCaller): {
  ownerType: CompletionRunOwnerType;
  ownerId: string;
} {
  return caller.billingOrganizationId
    ? { ownerType: CreditHolderType.Organization, ownerId: caller.billingOrganizationId }
    : { ownerType: CreditHolderType.User, ownerId: caller.userId };
}

/**
 * The run, when this caller minted it: same user and same billing owner. A missing run and someone
 * else's run get the same 404, so a run id reveals nothing about other accounts.
 */
export async function findCallerCompletionRun(runId: string, caller: CompletionRunCaller): Promise<ICompletionRun> {
  // _id is stored lowercase (randomUUID) but z.uuid accepts uppercase.
  const stored = await completionRunRepository.findById(runId.toLowerCase());
  const owner = completionRunOwnerOf(caller);
  if (
    !stored ||
    stored.userId !== caller.userId ||
    stored.ownerType !== owner.ownerType ||
    stored.ownerId !== owner.ownerId
  ) {
    throw new NotFoundError('Completion run not found. Create one with POST /api/v1/completion-runs.', {
      errorCode: RUN_NOT_FOUND_ERROR_CODE,
    });
  }
  return stored;
}
