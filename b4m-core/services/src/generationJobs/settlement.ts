import type { IGenerationJobDocument, IGenerationJobRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import {
  releaseCreditHold,
  settleCreditHold,
  type CreditHoldAdapters,
  type CreditLedgerEntry,
} from '../creditService/creditHold';

export type JobSettlementDeps = {
  repository: Pick<IGenerationJobRepository, 'recordSettlement'>;
  credits: CreditHoldAdapters;
  logger: Logger;
};

// recordSettlement is written right after credits move, before anything else can fail, so a manual repair of a
// stuck terminal claim (the engine's reportUnclaimable) can tell "settled, but markTerminalHandled was lost" from
// "never settled".

/** Returns a terminal job's whole hold. */
export async function releaseJobHold(job: IGenerationJobDocument, deps: JobSettlementDeps): Promise<void> {
  if (job.creditHold) await releaseCreditHold(job.creditHold, deps.credits);
  await deps.repository.recordSettlement(job.id, 0);
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
        params.entry,
        { featureLabel: params.featureLabel, logger: deps.logger },
        deps.credits
      )
    : 0;
  await deps.repository.recordSettlement(job.id, charged);
  return charged;
}
