import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { useEffect, useMemo, type ReactNode, useState } from 'react';
import { AgentPeekDrawer } from './AgentPeekDrawer';
import { playChime } from './chime';
import { ExampleQuestButtons } from './exampleQuests';
import { questAgents, useFinale, type ParentReport } from './finale';
import { FinaleBanner } from './FinaleBanner';
import { NeedsYouCard } from './NeedsYouCard';
import type { OrchestratorViewId } from './orchestratorPrefs';
import { assignPersonas, type AgentPersona } from '@shared/agentPersona';
import { formatRosterCost, summarizeRoster, type AgentView, type ParentView } from './roster';
import { TableView } from './TableView';
import { ViewSwitcher } from './ViewSwitcher';

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
  /** The orchestrating session itself; the Tavern draws it as the Innkeeper. */
  parent?: ParentView;
  onInnkeeperSelect?(): void;
  /** The run's finale is up: the Tavern raises its mugs. */
  celebrating?: boolean;
  /** Drawn over the top of the scene by a view that has one (the Tavern); other views leave it to the stage. */
  sceneOverlay?: ReactNode;
  /** Talking to the orchestrating conversation from the scene; the Tavern draws it as the Innkeeper's order slip. */
  desk?: InnkeeperDesk;
}

/** The parent conversation's front door in the scene: one thread, reached from the bar as well as the composer. */
export interface InnkeeperDesk {
  /** Sends to the parent conversation, as the composer does but without the composer's attachments. */
  send(text: string): void;
  /** The parent's latest finished reply, for the Innkeeper's speech bubble. */
  reply?: { id: string; snippet: string };
  /** "Read all" on that bubble: show the reply in the conversation. */
  onReadReply(id: string): void;
  /** Bring the whole conversation forward instead of the slip. */
  onOpenConversation(): void;
  /** The conversation is out of sight, so a reply has nowhere else to show. */
  conversationHidden: boolean;
  /** Bumped to open the slip; `seed` is a character typed while the Tavern was quiet. */
  openRequest?: { seq: number; seed: string };
}

/** The Tavern's chrome settling out when idle (ambient.ts); owned by the shell, which hides the dock and composer. */
export interface StageAmbient {
  settled: boolean;
  wake(): void;
  on: boolean;
  onToggle(on: boolean): void;
}

export interface OrchestratorStageProps {
  agents: readonly AgentView[];
  parent?: ParentView;
  /** Clicking the Innkeeper: bring the parent's own conversation forward. */
  onParentFocus?(): void;
  /** The orchestrating session; scopes the remembered finale. Without it the finale never plays. */
  rootId?: string;
  /** The parent's closing summary, once its transcript ends on one; the finale waits for it. */
  report?: ParentReport;
  /** The finale's "Read the report": show that summary. */
  onReadReport?(reportId: string): void;
  /** An agent to open in the peek drawer (a clicked needs-you notice); reported back once opened. */
  focusAgent?: string | null;
  onFocusAgentConsumed?(): void;
  /** An example quest picked on the empty stage: put its prompt in the composer. */
  onExampleQuest?(prompt: string): void;
  view: OrchestratorViewId;
  onViewChange(view: OrchestratorViewId): void;
  actions: AgentActions;
  introPlaying: boolean;
  /** Lets the Board and Tavern views register without the stage importing them; Table is the fallback for every id. */
  renderView?(view: OrchestratorViewId, props: OrchestratorViewProps): ReactNode;
  /** Rendered at the end of the header row. */
  dockControl?: ReactNode;
  /** Set while the session's Orchestrate behaviour is off: the empty stage offers to turn it on. */
  onTurnOn?(): void;
  desk?: InnkeeperDesk;
  ambient?: StageAmbient;
}

const NO_PARENT: ParentView = {};

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
`;

export function OrchestratorStage({
  agents,
  parent = NO_PARENT,
  onParentFocus,
  rootId,
  report,
  onReadReport,
  focusAgent = null,
  onFocusAgentConsumed,
  onExampleQuest,
  view,
  onViewChange,
  actions,
  introPlaying,
  renderView,
  dockControl,
  onTurnOn,
  desk,
  ambient,
}: OrchestratorStageProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keyed on ids, creation times and titles so status churn does not recompute names; the seed prompt
  // feeds only the epithet and is fixed once an agent is created.
  const personaKey = agents.map(agent => `${agent.id}@${agent.createdAt}@${agent.title}`).join('\n');
  const personas = useMemo(() => assignPersonas(agents), [personaKey]);
  const selected = agents.find(agent => agent.id === selectedId) ?? null;
  const hasSelection = selected !== null;

  useEffect(() => {
    if (!focusAgent) return;
    setSelectedId(focusAgent);
    onFocusAgentConsumed?.();
  }, [focusAgent]);

  useEffect(() => {
    if (!hasSelection) return;
    // On document, which hears a key before window does, and claimed: the drawer is the topmost
    // thing Escape can close, so the docked conversation beside it (ThreadDock) stays open.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      setSelectedId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [hasSelection]);

  const rosterSummary = summarizeRoster(agents);
  const { total, counts } = rosterSummary;
  // The parent waiting on an approval counts too, as it does on the app badge.
  const parentNeedsYou = parent.status === 'needs-action';
  const needsYou = counts['needs-you'] + (parentNeedsYou ? 1 : 0);
  const firstNeedsYou = agents.find(agent => agent.state === 'needs-you');
  const firstFailed = agents.find(agent => agent.state === 'failed');
  const needsYouPill = needsYou > 0 && (firstNeedsYou !== undefined || onParentFocus !== undefined);
  // Zero counts are noise, and the two that call for action get their own buttons instead. An empty
  // stage says nothing: "0 agents" would only repeat the empty state. An unknown cost is left out.
  const summary =
    total === 0
      ? ''
      : [
          `${total} ${total === 1 ? 'agent' : 'agents'}`,
          counts.working > 0 && `${counts.working} working`,
          needsYou > 0 && !needsYouPill && `${needsYou} need you`,
          counts.done > 0 && `${counts.done} done`,
          formatRosterCost(rosterSummary),
        ]
          .filter(Boolean)
          .join(' \u00B7 ');

  const quest = useMemo(() => questAgents(agents, report), [agents, report]);
  const finale = useFinale(rootId, quest, parent, report);
  useEffect(() => {
    if (finale.shown) playChime();
  }, [finale.shown]);

  // The Tavern seats the banner on its scene rather than in the letterbox above it.
  const bannerInScene = view === 'tavern' && renderView !== undefined && agents.length > 0;
  const banner = finale.shown && report && (
    <FinaleBanner
      agents={quest}
      placement={bannerInScene ? 'scene' : 'inline'}
      onRead={() => {
        finale.dismiss();
        onReadReport?.(report.id);
      }}
      onDismiss={finale.dismiss}
    />
  );

  const viewProps: OrchestratorViewProps = {
    agents,
    onSelect: setSelectedId,
    selectedId,
    introPlaying,
    personas,
    parent,
    onInnkeeperSelect: onParentFocus,
    celebrating: finale.shown,
    sceneOverlay: bannerInScene ? banner : undefined,
    desk,
  };

  const settled = ambient?.settled === true;
  // The parent first: it is the one whose answer everything else is waiting behind.
  const askingAgent = parentNeedsYou ? undefined : firstNeedsYou;
  const needsYouCard = settled && (parentNeedsYou || askingAgent) && (
    <NeedsYouCard
      key={askingAgent?.id ?? 'parent'}
      agent={askingAgent}
      name={askingAgent ? (personas.get(askingAgent.id)?.label ?? askingAgent.title) : 'The Innkeeper'}
      onOpen={() => {
        ambient?.wake();
        if (askingAgent) setSelectedId(askingAgent.id);
        else onParentFocus?.();
      }}
    />
  );

  return (
    <Box
      data-testid="orchestrator-stage"
      sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
    >
      {settled ? (
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          noWrap
          data-testid="orchestrator-ambient-status"
          sx={{ px: 1.5, py: 0.5 }}
        >
          {summary || 'The tavern is quiet'}
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.5, py: 1 }}>
          <ViewSwitcher
            view={view}
            onViewChange={onViewChange}
            ambient={ambient && { on: ambient.on, onToggle: ambient.onToggle }}
          />
          <Typography
            level="body-sm"
            noWrap
            title={summary}
            data-testid="orchestrator-summary-strip"
            sx={{ flex: '0 1 auto', minWidth: 0 }}
          >
            {summary}
          </Typography>
          {firstFailed && (
            <Button
              size="sm"
              color="danger"
              variant="soft"
              data-testid="orchestrator-failed-pill"
              onClick={() => setSelectedId(firstFailed.id)}
              sx={{ flexShrink: 0 }}
            >
              {counts.failed} failed
            </Button>
          )}
          {needsYouPill && (
            <Button
              size="sm"
              color="warning"
              variant="solid"
              data-testid="orchestrator-needs-you-pill"
              onClick={() => (firstNeedsYou ? setSelectedId(firstNeedsYou.id) : onParentFocus?.())}
              sx={{
                flexShrink: 0,
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
      )}
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Box
          sx={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: 'auto',
          }}
        >
          {!bannerInScene && banner}
          {agents.length === 0 ? (
            <EmptyStage
              tavern={view === 'tavern' && renderView ? renderView(view, viewProps) : null}
              onExampleQuest={onExampleQuest}
              onTurnOn={onTurnOn}
            />
          ) : renderView ? (
            renderView(view, viewProps)
          ) : (
            <TableView {...viewProps} />
          )}
          {needsYouCard}
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

/**
 * With no agents yet: the Tavern still opens with the Innkeeper at the bar; Board and Table show a line.
 * While Orchestrate is off, the example quests give way to the switch: a quest sent then would not delegate.
 */
function EmptyStage({
  tavern,
  onExampleQuest,
  onTurnOn,
}: {
  tavern: ReactNode;
  onExampleQuest?(prompt: string): void;
  onTurnOn?(): void;
}) {
  const quests = onTurnOn ? (
    <Button size="sm" variant="solid" color="primary" onClick={onTurnOn} data-testid="orchestrator-turn-on-btn">
      Turn on Orchestrate
    </Button>
  ) : (
    onExampleQuest && <ExampleQuestButtons onPick={onExampleQuest} />
  );
  const offLine = 'Orchestrate is off, so the assistant does the work itself in the conversation.';
  if (tavern) {
    return (
      <Box
        data-testid="orchestrator-empty-state"
        sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        {tavern}
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.25, p: 2 }}>
          <Typography level="body-sm" textColor="text.secondary" textAlign="center">
            {onTurnOn ? offLine : 'No quests yet. Describe the work and the Innkeeper will split it across agents.'}
          </Typography>
          {quests}
        </Box>
      </Box>
    );
  }
  return (
    <Box
      data-testid="orchestrator-empty-state"
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        p: 3,
      }}
    >
      <Typography level="body-sm" textColor="text.tertiary" textAlign="center">
        {onTurnOn ? offLine : 'No agents yet. Describe the work and it will be split across agents.'}
      </Typography>
      {quests}
    </Box>
  );
}
