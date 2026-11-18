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
  /** Releases a job's `runClaim`; a job carrying one without it logs the claim it cannot release. */
  runBudget?: Pick<RunBudgetAdapters, 'release'>;
};

// recordSettlement is written right after credits move, before anything else can fail, so a manual repair of a
// stuck terminal claim (the engine's reportUnclaimable) can tell "settled, but markTerminalHandled was lost" from
// "never settled".
// The run claim is released after it: the engine runs a kind's onTerminal at most once (claimTerminalHandling), so
// each job's claim is released exactly once or, on a crash in between, left over-counted on the run, never doubled.

/** Best effort: the credits already moved, so a failure leaves the run over-committed, which is logged to repair. */
async function releaseRunClaim(job: IGenerationJobDocument, chargedCredits: number, deps: JobSettlementDeps) {
  const { runClaim } = job;
  if (!runClaim) return;
  try {
    if (!deps.runBudget) throw new Error('No run budget adapters to release the run claim');
    await deps.runBudget.release(runClaim, chargedCredits);
  } catch (error) {
    deps.logger.error('generation_job_run_claim_release_failed', { jobId: job.id, runClaim, chargedCredits, error });
  }
}

// The run the job was made for, recorded as the ledger row's metadata.run so the run's usage read counts it.
const ledgerEntryFor = (job: IGenerationJobDocument, entry: CreditLedgerEntry): CreditLedgerEntry => {
  const withApiKey = job.apiKeyId && !entry.apiKeyId ? { ...entry, apiKeyId: job.apiKeyId } : entry;
  return job.run && !withApiKey.run ? { ...withApiKey, run: job.run } : withApiKey;
};

/** Returns a terminal job's whole hold. */
export async function releaseJobHold(job: IGenerationJobDocument, deps: JobSettlementDeps): Promise<void> {
  if (job.creditHold) await releaseCreditHold(job.creditHold, deps.credits);
  await deps.repository.recordSettlement(job.id, 0);
  await releaseRunClaim(job, 0, deps);
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
  const charged = job.creditHold
    ? await settleCreditHold(
        job.creditHold,
        params.credits,
        ledgerEntryFor(job, params.entry),
        { featureLabel: params.featureLabel, logger: deps.logger },
        deps.credits
      )
    : 0;
  await deps.repository.recordSettlement(job.id, charged);
  await releaseRunClaim(job, charged, deps);
  return charged;
}
