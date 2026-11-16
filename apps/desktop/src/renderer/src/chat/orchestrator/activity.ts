import { SESSION_SETUP_LABEL } from '@shared/chat';
import { activityLabel } from '@shared/agentActivity';
import type { AgentView } from './roster';

export {
  activityLabel,
  bufferUntrackedActivity,
  foldActivity,
  toolKind,
  type AgentActivity,
  type ToolKind,
} from '@shared/agentActivity';

/** The "Now" text shared by the table and board: live activity while working, the gated call while it
 * waits on approval, else how its last reply ended. */
export function agentNowText(
  agent: Pick<AgentView, 'state' | 'preparing' | 'activity' | 'lastSnippet'>
): string | undefined {
  if (agent.state === 'working' && agent.preparing) return SESSION_SETUP_LABEL[agent.preparing];
  if (agent.state === 'working' && agent.activity) return activityLabel(agent.activity);
  // A call parked at the approval gate is still the agent's current tool.
  if (agent.state === 'needs-you' && agent.activity?.kind === 'tool')
    return `Waiting for approval: ${activityLabel(agent.activity)}`;
  return agent.lastSnippet || undefined;
}
