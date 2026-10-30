import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import ToggleButtonGroup from '@mui/joy/ToggleButtonGroup';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { useEffect, type ReactNode, useState } from 'react';
import { AgentPeekDrawer } from './AgentPeekDrawer';
import { ORCHESTRATOR_VIEWS, type OrchestratorViewId } from './orchestratorPrefs';
import { formatAgentCost, summarizeRoster, type AgentView } from './roster';
import { TableView } from './TableView';

export interface AgentActions {
  open(id: string): void;
  stop(id: string): void;
  archive(id: string): void;
}

export interface OrchestratorViewProps {
  agents: readonly AgentView[];
  onSelect(id: string): void;
  selectedId: string | null;
  introPlaying: boolean;
}

interface OrchestratorStageProps {
  agents: readonly AgentView[];
  view: OrchestratorViewId;
  onViewChange(view: OrchestratorViewId): void;
  actions: AgentActions;
  introPlaying: boolean;
  /** Lets the Board and Tavern views register without the stage importing them; Table is the fallback for every id. */
  renderView?(view: OrchestratorViewId, props: OrchestratorViewProps): ReactNode;
  /** Rendered at the end of the header row. */
  dockControl?: ReactNode;
}

const VIEW_LABEL: Record<OrchestratorViewId, string> = { tavern: 'Tavern', board: 'Board', table: 'Table' };

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
`;

export function OrchestratorStage({
  agents,
  view,
  onViewChange,
  actions,
  introPlaying,
  renderView,
  dockControl,
}: OrchestratorStageProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = agents.find(agent => agent.id === selectedId) ?? null;
  const hasSelection = selected !== null;

  useEffect(() => {
    if (!hasSelection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented) setSelectedId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasSelection]);

  const { total, counts, usdCost, credits, costPartial } = summarizeRoster(agents);
  const cost = formatAgentCost(usdCost === 0 && credits > 0 ? undefined : usdCost, credits);
  const needsYou = counts['needs-you'];
  const firstNeedsYou = agents.find(agent => agent.state === 'needs-you');

  const viewProps: OrchestratorViewProps = { agents, onSelect: setSelectedId, selectedId, introPlaying };

  return (
    <Box
      data-testid="orchestrator-stage"
      sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, py: 1, flexWrap: 'wrap' }}>
        <ToggleButtonGroup
          size="sm"
          value={view}
          onChange={(_event, next) => {
            if (next) onViewChange(next);
          }}
        >
          {ORCHESTRATOR_VIEWS.map(id => (
            <Button key={id} value={id} data-testid={`orchestrator-view-tab-${id}`}>
              {VIEW_LABEL[id]}
            </Button>
          ))}
        </ToggleButtonGroup>
        <Typography level="body-sm" data-testid="orchestrator-summary-strip">
          {`${total} agents \u00B7 ${counts.working} working \u00B7 ${needsYou} need you \u00B7 ${counts.done} done \u00B7 ${counts.failed} failed \u00B7 ${costPartial ? '~' : ''}${cost}`}
        </Typography>
        {needsYou > 0 && firstNeedsYou && (
          <Button
            size="sm"
            color="warning"
            variant="solid"
            data-testid="orchestrator-needs-you-pill"
            onClick={() => setSelectedId(firstNeedsYou.id)}
            sx={{
              animation: `${pulse} 1.6s ease-in-out infinite`,
              '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
            }}
          >
            {needsYou} need you
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        {dockControl}
      </Box>
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
          {renderView ? renderView(view, viewProps) : <TableView {...viewProps} />}
        </Box>
        {selected && (
          <AgentPeekDrawer key={selected.id} agent={selected} onClose={() => setSelectedId(null)} actions={actions} />
        )}
      </Box>
    </Box>
  );
}
