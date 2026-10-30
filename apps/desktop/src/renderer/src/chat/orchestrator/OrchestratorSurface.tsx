import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { OrchestratorStage, type OrchestratorStageProps } from './OrchestratorStage';
import { useOrchestratorRoster } from './useOrchestrator';

interface OrchestratorSurfaceProps extends Omit<OrchestratorStageProps, 'agents'> {
  rootId: string;
  sessions: readonly ChatSessionSummary[];
  statuses: ReadonlyMap<string, ChatSessionStatus>;
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
  prSummaries,
  ...stageProps
}: OrchestratorSurfaceProps) {
  const agents = useOrchestratorRoster(rootId, sessions, statuses, prSummaries);
  return <OrchestratorStage agents={agents} {...stageProps} />;
}
