import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Switch from '@mui/joy/Switch';
import ToggleButtonGroup from '@mui/joy/ToggleButtonGroup';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { useEffect, useMemo, type ReactNode, useState } from 'react';
import { AgentPeekDrawer } from './AgentPeekDrawer';
import { ORCHESTRATOR_VIEWS, type OrchestratorViewId } from './orchestratorPrefs';
import { assignPersonas, type AgentPersona } from './tavern/agentPersona';
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
  personas: ReadonlyMap<string, AgentPersona>;
}

export interface OrchestratorStageProps {
  agents: readonly AgentView[];
  view: OrchestratorViewId;
  onViewChange(view: OrchestratorViewId): void;
  actions: AgentActions;
  introPlaying: boolean;
  /** Lets the Board and Tavern views register without the stage importing them; Table is the fallback for every id. */
  renderView?(view: OrchestratorViewId, props: OrchestratorViewProps): ReactNode;
  /** Rendered at the end of the header row. */
  dockControl?: ReactNode;
  /** The session's Orchestrate behaviour, separate from which surface is shown; Code sessions only. */
  delegate?: { on: boolean; onChange(on: boolean): void };
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
  delegate,
}: OrchestratorStageProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keyed on ids and creation times so status churn does not recompute names; titles and prompts feed
  // only the epithet, which is fixed once an agent is created.
  const personaKey = agents.map(agent => `${agent.id}@${agent.createdAt}`).join('\n');
  const personas = useMemo(() => assignPersonas(agents), [personaKey]);
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

  const { total, counts, usdCost, credits, hasUsd, hasCost, costPartial } = summarizeRoster(agents);
  const cost = hasCost ? formatAgentCost(hasUsd ? usdCost : undefined, credits) : '-';
  const needsYou = counts['needs-you'];
  const firstNeedsYou = agents.find(agent => agent.state === 'needs-you');

  const viewProps: OrchestratorViewProps = { agents, onSelect: setSelectedId, selectedId, introPlaying, personas };

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
          {`${total} ${total === 1 ? 'agent' : 'agents'} \u00B7 ${counts.working} working \u00B7 ${needsYou} need you \u00B7 ${counts.done} done \u00B7 ${counts.failed} failed \u00B7 ${costPartial ? '~' : ''}${cost}`}
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
        {delegate && (
          <Typography
            component="label"
            level="body-sm"
            data-testid="orchestrator-delegate-switch"
            startDecorator={
              <Switch size="sm" checked={delegate.on} onChange={event => delegate.onChange(event.target.checked)} />
            }
          >
            Delegate to agents
          </Typography>
        )}
        {dockControl}
      </Box>
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
          {agents.length === 0 ? (
            <Box
              data-testid="orchestrator-empty-state"
              sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}
            >
              <Typography level="body-sm" textColor="text.tertiary" textAlign="center">
                No agents yet. Describe the work and it will be split across agents.
              </Typography>
            </Box>
          ) : renderView ? (
            renderView(view, viewProps)
          ) : (
            <TableView {...viewProps} />
          )}
        </Box>
        {selected && (
          <AgentPeekDrawer
            key={selected.id}
            agent={selected}
            persona={personas.get(selected.id)}
            onClose={() => setSelectedId(null)}
            actions={actions}
          />
        )}
      </Box>
    </Box>
  );
}
