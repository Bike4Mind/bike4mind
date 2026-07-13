/**
 * CreditCounter - live tally of credits consumed by an in-flight agent
 * execution. Mounted by `ActiveAgentExecutions` next to `ExecutionStatusBanner`
 * during a run, and persists once the run completes so the user can see the
 * final bill before the iteration stream is dismissed.
 *
 * The store accumulates `totalCreditsUsed` from two sources:
 *   - per-iteration `progress.creditsUsed` deltas during the run
 *     (apps/client/server/queueHandlers/agentExecutor.ts emits these)
 *   - the authoritative `completed.totalCreditsUsed` on terminal success
 *
 * So this component is a thin reactive view over a single store field -
 * subscribing narrowly via a selector keeps re-renders to credit changes only.
 */

import { FC } from 'react';
import { Chip } from '@mui/joy';
import { useAgentExecutionStore, selectExecution } from '@client/app/stores/useAgentExecutionStore';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';

interface CreditCounterProps {
  executionId: string;
}

function formatCredits(credits: number): string {
  // Round to whole credits - sub-credit precision is noise at this surface
  // (the executor emits fractional deltas per LLM call). The accounting
  // ledger keeps the precise value; users just want a ballpark.
  const rounded = Math.round(credits);
  return rounded.toLocaleString();
}

const CreditCounter: FC<CreditCounterProps> = ({ executionId }) => {
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const totalCreditsUsed = useAgentExecutionStore(state => selectExecution(executionId)(state)?.totalCreditsUsed);

  // Nothing decrements while enforcement is off, so a running tally would be cosmetic.
  if (!enforceCredits) return null;

  // `undefined` only when the execution isn't in the store yet; once it's
  // there the field is 0+. Hide on undefined; show even at 0 so the user
  // gets immediate feedback that the counter is wired up.
  if (totalCreditsUsed === undefined) return null;

  return (
    <Chip data-testid={`credit-counter-${executionId}`} size="sm" variant="soft" color="primary">
      {formatCredits(totalCreditsUsed)} credits
    </Chip>
  );
};

export default CreditCounter;
