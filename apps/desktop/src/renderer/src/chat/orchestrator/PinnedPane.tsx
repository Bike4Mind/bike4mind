import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import Typography from '@mui/joy/Typography';
import { useMemo, type ReactNode } from 'react';
import type { ChatSessionStatus, ChatSessionSummary, SessionSetupStep } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { assignPersonas } from '@shared/agentPersona';
import type { ViewAction } from '@shared/viewSnapshot';
import type { OrchestratorViewProps } from './OrchestratorStage';
import type { OrchestratorViewId } from './orchestratorViews';
import { redactForPresenter, restorePresentedAction } from './presenter';
import { useOrchestratorRoster } from './useOrchestrator';

/** What a pane pinned to another session builds that session's roster from; the shell's own session data. */
export interface PaneSessionSource {
  sessions: readonly ChatSessionSummary[];
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  prSummaries: ReadonlyMap<string, PrSummary>;
  preparing?: ReadonlyMap<string, SessionSetupStep>;
}

interface PinnedPaneProps {
  rootId: string;
  view: OrchestratorViewId;
  /** Shown on the pane, so it is clear the pane is not the active session. */
  label: string;
  source: PaneSessionSource;
  renderView(view: OrchestratorViewId, props: OrchestratorViewProps): ReactNode;
  /** Opens a session in the shell: a pinned pane never drives the active stage's selection. */
  onOpenSession(id: string): void;
  /** Presenter mode's agent numbers (the stage's), or undefined when not presenting. */
  presenterNumbers?: ReadonlyMap<string, number>;
  settled: boolean;
}

/**
 * One stage pane showing another session's roster. Mounted only while a pane is pinned, so its activity
 * subscription (useOrchestratorRoster) lives no longer than the pin. Presenter mode redacts it as the stage does.
 */
export function PinnedPane({
  rootId,
  view,
  label,
  source,
  renderView,
  onOpenSession,
  presenterNumbers,
  settled,
}: PinnedPaneProps) {
  const roster = useOrchestratorRoster(rootId, source.sessions, source.statuses, source.prSummaries, source.preparing);
  const presenting = presenterNumbers !== undefined;
  const shown = useMemo(
    () => (presenterNumbers ? redactForPresenter({ ...roster, approvals: [] }, presenterNumbers) : roster),
    [roster, presenterNumbers]
  );
  const personaKey = shown.agents.map(agent => `${agent.id}@${agent.createdAt}@${agent.title}`).join('\n');
  const personas = useMemo(() => assignPersonas(shown.agents), [personaKey]);

  const viewProps: OrchestratorViewProps = {
    agents: shown.agents,
    rootId,
    onSelect: onOpenSession,
    selectedId: null,
    introPlaying: false,
    personas,
    parent: shown.parent,
    onInnkeeperSelect: () => onOpenSession(rootId),
    settled,
    restoreAction: presenting ? (action: ViewAction) => restorePresentedAction(action, roster.agents) : undefined,
  };

  return (
    <Box
      data-testid="orchestrator-pinned-pane"
      data-session-id={rootId}
      sx={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
    >
      <Chip
        size="sm"
        variant="soft"
        color="primary"
        title={label}
        data-testid="orchestrator-pinned-pane-label"
        sx={{ position: 'absolute', top: 6, right: 8, zIndex: 5, maxWidth: 'calc(100% - 16px)', pointerEvents: 'none' }}
      >
        {label}
      </Chip>
      {shown.agents.length === 0 ? (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}>
          <Typography level="body-sm" textColor="text.tertiary" textAlign="center">
            No agents in this session yet.
          </Typography>
        </Box>
      ) : (
        renderView(view, viewProps)
      )}
    </Box>
  );
}
