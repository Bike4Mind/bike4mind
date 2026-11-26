import {
  CreditHolderType,
  NotFoundError,
  RUN_NOT_FOUND_ERROR_CODE,
  type CompletionRun,
  type CompletionRunBudgetState,
  type CompletionRunSpend,
} from '@bike4mind/common';
import { completionRunRepository, type CompletionRunOwnerType, type ICompletionRun } from '@bike4mind/database';
import { resolveCompletionBillingOrgId } from '@server/billing/resolveCompletionBillingOrgId';

/** Who is calling a completion-run route: the user, and the organization an org-billed API key draws on. */
export type CompletionRunCaller = { userId: string; billingOrganizationId?: string };

/**
 * The caller a completion-run route acts as, with its billing org resolved from the request's
 * `organization_id` exactly as the completions route resolves it (resolveCompletionBillingOrgId), so a
 * run minted for a payer is found again by the completions that charge that payer.
 */
export async function resolveCompletionRunCaller(
  {
    userId,
    apiKeyInfo,
  }: { userId: string; apiKeyInfo?: Pick<Express.ApiKeyInfo, 'billingOwnerType' | 'organizationId' | 'scopes'> },
  requestedOrgId: string | null | undefined
): Promise<CompletionRunCaller> {
  const billingOrganizationId = await resolveCompletionBillingOrgId({ apiKeyInfo, requestedOrgId, userId });
  return { userId, billingOrganizationId };
}

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

/** The public shape of a run, as the mint and budget routes return it. */
export function toCompletionRunBody(run: ICompletionRun): CompletionRun {
  return {
    runId: run.runId,
    ...(run.evaluation && { evaluation: run.evaluation }),
    ...(run.rootSessionId !== undefined && { rootSessionId: run.rootSessionId }),
    ...(run.budgetCredits !== undefined && { budgetCredits: run.budgetCredits }),
    createdAt: run.createdAt.toISOString(),
  };
}

/**
 * A budgeted run's ceiling against its committed total. The unsettled part is the committed total less
 * the ledger's settled charges; both only ever move together inside a hold's terminal transaction.
 */
export function toCompletionRunBudgetState(
  run: ICompletionRun,
  settled: CompletionRunSpend
): CompletionRunBudgetState | undefined {
  if (run.budgetCredits === undefined) return undefined;
  const committedCredits = Math.max(0, run.committedCredits ?? 0);
  return {
    budgetCredits: run.budgetCredits,
    committedCredits,
    reservedCredits: Math.max(0, committedCredits - settled.creditsCharged),
    remainingCredits: Math.max(0, run.budgetCredits - committedCredits),
  };
}
