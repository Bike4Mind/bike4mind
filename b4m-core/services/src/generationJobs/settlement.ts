import type { IGenerationJobDocument, IGenerationJobRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import {
  releaseCreditHold,
  settleCreditHold,
  type CreditHoldAdapters,
  type CreditLedgerEntry,
} from '../creditService/creditHold';
import type { RunBudgetAdapters } from './types';

export type JobSettlementDeps = {
  repository: Pick<IGenerationJobRepository, 'recordSettlement'>;
  credits: CreditHoldAdapters;
  logger: Logger;
  /** Releases a job's `runClaim` in the settlement's transaction; a job carrying one without it logs the claim. */
  runBudget?: Pick<RunBudgetAdapters, 'release' | 'transact'>;
};

// recordSettlement is written right after credits move, before anything else can fail, so a manual repair of a
// stuck terminal claim (the engine's reportUnclaimable) can tell "settled, but markTerminalHandled was lost" from
// "never settled".
// A run claim is released in the same transaction as the credit move and recordSettlement, so the three commit or
// fail together: a crash between them can no longer leave the claim held on the run. The engine runs a kind's
// onTerminal at most once (claimTerminalHandling), so a failed transaction is alarmed, never retried or doubled.

/**
 * Moves the credits (`moveCredits` returns the charge), records the settlement and releases the job's run claim
 * down to that charge. A job without a claim settles exactly as before. `inTransaction` tells `moveCredits` to throw
 * on a failed write rather than log it, so the transaction aborts instead of committing a partial settlement.
 */
async function settle(
  job: IGenerationJobDocument,
  deps: JobSettlementDeps,
  moveCredits: (inTransaction: boolean) => Promise<number>
): Promise<number> {
  const { runClaim } = job;
  const runBudget = deps.runBudget;
  if (!runClaim || !runBudget) {
    const charged = await moveCredits(false);
    await deps.repository.recordSettlement(job.id, charged);
    if (runClaim) {
      deps.logger.error('generation_job_run_claim_release_failed', {
        jobId: job.id,
        runClaim,
        chargedCredits: charged,
        error: new Error('No run budget adapters to release the run claim'),
      });
    }
    return charged;
  }
  return runBudget.transact(async () => {
    const charged = await moveCredits(true);
    await deps.repository.recordSettlement(job.id, charged);
    await runBudget.release(runClaim, charged);
    return charged;
  });
}

// The run the job was made for, recorded as the ledger row's metadata.run so the run's usage read counts it.
const ledgerEntryFor = (job: IGenerationJobDocument, entry: CreditLedgerEntry): CreditLedgerEntry => {
  const withApiKey = job.apiKeyId && !entry.apiKeyId ? { ...entry, apiKeyId: job.apiKeyId } : entry;
  return job.run && !withApiKey.run ? { ...withApiKey, run: job.run } : withApiKey;
};

/** Returns a terminal job's whole hold. */
export async function releaseJobHold(job: IGenerationJobDocument, deps: JobSettlementDeps): Promise<void> {
  await settle(job, deps, async () => {
    if (job.creditHold) await releaseCreditHold(job.creditHold, deps.credits);
    return 0;
  });
}

/**
 * Charges `credits` against a terminal job's hold and returns what was charged (0 without a hold). NaN, a
 * pricing failure, makes settleCreditHold keep the full reservation and log it at error level.
 */
export async function settleJobHold(
  job: IGenerationJobDocument,
  params: { credits: number; entry: CreditLedgerEntry; featureLabel: string },
  deps: JobSettlementDeps
): Promise<number> {
  const { creditHold } = job;
  return settle(job, deps, async inTransaction =>
    creditHold
      ? settleCreditHold(
          creditHold,
          params.credits,
          ledgerEntryFor(job, params.entry),
          { featureLabel: params.featureLabel, logger: deps.logger, throwOnWriteFailure: inTransaction },
          deps.credits
        )
      : 0
  );
}
