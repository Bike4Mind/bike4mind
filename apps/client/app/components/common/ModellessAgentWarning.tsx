import { Alert } from '@mui/joy';
import WarningIcon from '@mui/icons-material/Warning';

/**
 * Shared advisory for agents without an explicit model. The embed chat bridge
 * rejects such agents with a 422 (the enforcement layer); these are the
 * matching UI warnings shown wherever an embed key or its agent is edited.
 * Copy must stay identical across surfaces so operators see one message.
 */
export const MODELLESS_AGENT_WARNING =
  'This agent is on the system default model. Embed chat requires an explicit model, so end-user chats will be ' +
  'rejected until you set one on the agent.';

// Positive knowledge only: the agent must be in the fetched list AND model-less
// ('' and unset both mean "System Default"). Unknown agents produce no warning.
export const isModellessAgent = (agent?: { preferredModel?: string } | null): boolean =>
  !!agent && !agent.preferredModel;

export function ModellessAgentAlert({ testId }: { testId: string }) {
  return (
    <Alert color="warning" startDecorator={<WarningIcon />} sx={{ mt: 1 }} data-testid={testId}>
      {MODELLESS_AGENT_WARNING}
    </Alert>
  );
}
