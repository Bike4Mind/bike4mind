import type { ChatSessionStatus, ChatSessionSummary, SessionSetupStep } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { OrchestratorStage, type OrchestratorStageProps } from './OrchestratorStage';
import { useOrchestratorRoster } from './useOrchestrator';

interface OrchestratorSurfaceProps extends Omit<OrchestratorStageProps, 'agents' | 'parent' | 'rootId'> {
  rootId: string;
  sessions: readonly ChatSessionSummary[];
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  preparing?: ReadonlyMap<string, SessionSetupStep>;
  prSummaries: ReadonlyMap<string, PrSummary>;
}

/**
 * The stage plus the roster behind it. Owns the only agent-activity stream subscription, so it
 * exists only while orchestrating; never pair it with another useAgentActivity.
 */
export function OrchestratorSurface({
  rootId,
  sessions,
  statuses,
  preparing,
  prSummaries,
  ...stageProps
}: OrchestratorSurfaceProps) {
  const { agents, parent } = useOrchestratorRoster(rootId, sessions, statuses, prSummaries, preparing);
  return <OrchestratorStage agents={agents} parent={parent} rootId={rootId} {...stageProps} />;
}
