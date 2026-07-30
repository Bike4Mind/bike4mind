/**
 * CreditCounter - live tally of credits consumed by an in-flight agent
 * execution. Mounted by `ActiveAgentExecutions` next to `ExecutionStatusBanner`
 * only while the run is active; it unmounts on terminal status. The final bill
 * then lives in chat history via the persisted Quest's `creditsUsed`
 * (persistRunAsQuest -> MessageContent), not this transient store view.
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
import { Chip, Tooltip } from '@mui/joy';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import { useAgentExecutionStore, selectExecution } from '@client/app/stores/useAgentExecutionStore';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';

interface CreditCounterProps {
  executionId: string;
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

  // Round to whole credits - sub-credit precision is noise at this surface
  // (the executor emits fractional deltas per LLM call).
  const rounded = Math.round(totalCreditsUsed);

  // Matches the per-reply "credits used" chip in MessageContent: fileBrowser
  // statusChip palette + Bike4Mind icon + bare number, with the count in the
  // tooltip. Keeps the running tally visually consistent with the final bill.
  return (
    <Tooltip title={`Credits Used: ${rounded}`}>
      <Chip
        data-testid={`credit-counter-${executionId}`}
        size="sm"
        variant="soft"
        sx={theme => ({
          bgcolor: theme.palette.fileBrowser.statusChip.backgroundColor,
          color: theme.palette.fileBrowser.statusChip.textColor,
          fontSize: '13px',
          height: '24px',
          border: `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`,
          gap: '4px',
          px: '8px',
          fontWeight: 500,
        })}
        startDecorator={<Bike4MindIcon size="12" fill="currentColor" />}
      >
        {rounded}
      </Chip>
    </Tooltip>
  );
};

export default CreditCounter;
