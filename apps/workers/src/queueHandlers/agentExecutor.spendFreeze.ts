import { isSpendFrozenError, type ISpendFreezeRepository } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import { spendFreezeSubjectForRequest } from '@bike4mind/server-utils/billing/spendFreezeSubject';

/** The run identity a spend freeze is read for; `organizationId` is the org the run is billed to. */
export type SpendFreezeRun = {
  userId: string;
  organizationId?: string | null;
  apiKeyId?: string | null;
};

export type SpendFreezeDenialDeps = {
  spendFreezes: Pick<ISpendFreezeRepository, 'findActiveForSubject'>;
};

/**
 * Reads whether any scope the run spends under is frozen: the refusal message, or null when spend is allowed.
 * Always a live read (a freeze lands mid-run). A failed read propagates so the caller decides: the run fails closed
 * (the outer catch marks it failed and acks), like the account gate; subagent checks fail closed too.
 */
export function createSpendFreezeDenialReader(
  run: SpendFreezeRun,
  deps: SpendFreezeDenialDeps
): () => Promise<string | null> {
  return async () => {
    const subject = spendFreezeSubjectForRequest(
      {
        user: { id: run.userId },
        apiKeyInfo: { keyId: run.apiKeyId ?? undefined },
      },
      run.organizationId ?? null
    );
    try {
      await creditService.assertSpendNotFrozen(subject, { db: { spendFreezes: deps.spendFreezes } });
      return null;
    } catch (error) {
      if (isSpendFrozenError(error)) return error.message;
      throw error;
    }
  };
}
