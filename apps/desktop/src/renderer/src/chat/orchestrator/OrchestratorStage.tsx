import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { useCallback, useEffect, useMemo, useRef, type ReactNode, useState } from 'react';
import { AgentPeekDrawer } from './AgentPeekDrawer';
import { AgentPrDialog } from './AgentPrDialog';
import { playSoundEvent } from './chime';
import { useAgentSoundEvents } from './soundEvents';
import { activeSoundPack, resolveEventSound } from './soundPacks';
import { questAgents, useFinale, type ParentReport } from './finale';
import { FinaleBanner } from './FinaleBanner';
import { FocusPanel } from './FocusPanel';
import { useRunSpend } from './runSpend';
import { NeedsYouCard } from './NeedsYouCard';
import { toMiniPayload, useOrchestrateMiniWindow, usePublishOrchestrateMini } from './orchestrateMini';
import { numberAgents, redactForPresenter, restorePresentedAction, type PresentedStage } from './presenter';
import type { OrchestratorViewId } from './orchestratorPrefs';
import type { OrchestratorLayout, OrchestratorPane } from './orchestratorLayout';
import { StageLayout } from './StageLayout';
import { pinLabel, resolvePaneSession } from './panePins';
import { PinnedPane, type PaneSessionSource } from './PinnedPane';
import { assignPersonas, type AgentPersona } from '@shared/agentPersona';
import { formatRosterCost, summarizeRoster, type AgentView, type ParentView } from './roster';
import { TableView } from './TableView';
import { ORCHESTRATOR_VIEW_INFO, ViewSwitcher } from './ViewSwitcher';
import { useApplySkin, useSkinTheme } from './skins';
import { SKIN_STAGE_VARIABLE } from './statePalette';
import { useQuickApprovals } from './quickApprovals';
import { runViewAction, toViewSnapshot } from './viewSnapshot';
import { acceptViewAction, type ViewAction } from '@shared/viewSnapshot';
import { useAvatarDetailsPosition } from './useAvatarDetailsPosition';

export interface AgentActions {
  open(id: string): void;
  stop(id: string): void | Promise<void>;
  archive(id: string): void;
}

export interface OrchestratorViewProps {
  agents: readonly AgentView[];
  /** The orchestrating session, for a view built on the snapshot (snapshotView.tsx). */
  rootId?: string;
  onSelect(id: string): void;
  onOpenPr?(id: string): void;
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
  /** Agent details, positioned relative to the artwork rather than its surrounding letterbox. */
  agentDetailsOverlay?: ReactNode;
  /** The parent's latest reply, shown at the bar while its conversation is hidden. */
  desk?: InnkeeperDesk;
  /** The chrome has settled out (StageAmbient); the Tavern dims to last call and fills the pane. */
  settled?: boolean;
  /**
   * Turns an accepted action on the snapshot built from these props back into the same action on the real
   * roster (Presenter mode's placeholder option labels); absent when the props are not redacted.
   */
  restoreAction?(action: ViewAction): ViewAction;
}

/** The parent conversation's front door in the scene: one thread, reached from the bar as well as the composer. */
export interface InnkeeperDesk {
  /** The parent's latest finished reply, for the Innkeeper's speech bubble. */
  reply?: { id: string; snippet: string };
  /** "Read all" on that bubble: show the reply in the conversation. */
  onReadReply(id: string): void;
  /** The conversation is out of sight, so a reply has nowhere else to show. */
  conversationHidden: boolean;
}

/** Focus mode (FocusPanel): owned by the shell, which also keeps the ambient settle off while it is on. */
export interface StageFocus {
  on: boolean;
  onToggle(on: boolean): void;
}

/**
 * Presenter mode (presenter.ts): the stage redacts what it hands every view, and shows a badge. Owned by the
 * shell; the peek drawer and the conversation are not redacted.
 */
export interface StagePresenter {
  on: boolean;
  onToggle(on: boolean): void;
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
  selection?: { id: string | null; onChange(id: string | null): void };
  parent?: ParentView;
  /** Bring the parent's own conversation forward for an attention action. */
  onParentFocus?(): void;
  onParentToggle?(): void;
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
  /** The panes and the view in each (orchestratorLayout.ts); one pane is the stage as a single view. */
  layout: OrchestratorLayout;
  onLayoutChange(layout: OrchestratorLayout): void;
  actions: AgentActions;
  onOpenPrLink?(sessionId: string, url: string): void;
  introPlaying: boolean;
  /**
   * Lets the Board and Tavern views register without the stage importing them; Table is the fallback for every
   * id. Every pane is drawn through this with the same props, so redaction, palette and skin reach each one.
   */
  renderView?(view: OrchestratorViewId, props: OrchestratorViewProps): ReactNode;
  /** Rendered at the end of the header row. */
  dockControl?: ReactNode;
  desk?: InnkeeperDesk;
  ambient?: StageAmbient;
  focus?: StageFocus;
  /** Showing the parent conversation takes precedence over an agent peek. */
  conversationRequest?: number;
  presenter?: StagePresenter;
  /**
   * The shell's sessions, so a pane in a split can be pinned to another session (panePins.ts) and draw its
   * roster. Without it every pane shows this stage's roster.
   */
  paneSessions?: PaneSessionSource;
}

const NO_PARENT: ParentView = {};
const NO_NUMBERS: ReadonlyMap<string, number> = new Map();

/** Presenter mode's agent numbers: given in roster order as agents first show, kept until the mode is turned off. */
export function usePresenterNumbers(on: boolean, agents: readonly AgentView[]): ReadonlyMap<string, number> {
  const numbers = useRef(NO_NUMBERS);
  // Written during render on purpose: numberAgents is deterministic and idempotent, so a double render is
  // harmless, and moving it to an effect would flash the real titles for a frame.
  numbers.current = on ? numberAgents(numbers.current, agents) : NO_NUMBERS;
  return numbers.current;
}

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
`;

export function OrchestratorStage({
  agents: rosterAgents,
  selection,
  parent: rosterParent = NO_PARENT,
  onParentFocus,
  onParentToggle,
  rootId,
  report,
  onReadReport,
  focusAgent = null,
  onFocusAgentConsumed,
  layout,
  onLayoutChange,
  actions,
  onOpenPrLink,
  introPlaying,
  renderView,
  dockControl,
  desk: rosterDesk,
  ambient,
  focus,
  conversationRequest,
  presenter,
  paneSessions,
}: OrchestratorStageProps) {
  const [prAgentId, setPrAgentId] = useState<string | null>(null);
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const selectedId = selection ? selection.id : localSelectedId;
  const onSelectionChange = selection?.onChange;
  const setSelectedId = useCallback(
    (id: string | null) => (onSelectionChange ? onSelectionChange(id) : setLocalSelectedId(id)),
    [onSelectionChange]
  );
  const focused = focus?.on === true && rootId !== undefined && rosterAgents.length > 0;
  const rosterApprovals = useQuickApprovals(focused, rootId, rosterAgents, rosterParent);

  // The one place Presenter mode applies: everything below draws from `agents`, `parent`, `approvals` and
  // `desk`, except the peek drawer, which reads the real roster.
  const presenting = presenter?.on === true;
  const presenterNumbers = usePresenterNumbers(presenting, rosterAgents);
  const shown = useMemo((): PresentedStage => {
    const real = { agents: rosterAgents, parent: rosterParent, approvals: rosterApprovals, desk: rosterDesk };
    return presenting ? redactForPresenter(real, presenterNumbers) : real;
  }, [presenting, presenterNumbers, rosterAgents, rosterParent, rosterApprovals, rosterDesk]);
  const { agents, parent, approvals, desk } = shown;
  const prAgent = !presenting && agents.find(agent => agent.id === prAgentId && agent.pr);
  useEffect(() => {
    if (!prAgent) setPrAgentId(null);
  }, [prAgent]);
  useEffect(() => setPrAgentId(null), [rootId]);
  const openPr = (id: string) => {
    if (!presenting && agents.some(agent => agent.id === id && agent.pr)) setPrAgentId(id);
  };
  const restoreAction = presenting ? (action: ViewAction) => restorePresentedAction(action, rosterAgents) : undefined;

  // Scene-only extras (a banner or agent details placed in the artwork, the Innkeeper's empty stage) belong to
  // a stage showing one view; in a split they fall back to the stage's own, shared by every pane.
  const view = layout.panes[0].view;
  const split = layout.panes.length > 1;
  // Keyed on ids, creation times and titles so status churn does not recompute names; the seed prompt
  // feeds only the epithet and is fixed once an agent is created.
  const personaKey = agents.map(agent => `${agent.id}@${agent.createdAt}@${agent.title}`).join('\n');
  const personas = useMemo(() => assignPersonas(agents), [personaKey]);
  const realPersonaKey = presenting
    ? rosterAgents.map(agent => `${agent.id}@${agent.createdAt}@${agent.title}`).join('\n')
    : '';
  const realPersonas = useMemo(() => (presenting ? assignPersonas(rosterAgents) : undefined), [realPersonaKey]);
  const selected = rosterAgents.find(agent => agent.id === selectedId) ?? null;
  const hasSelection = selected !== null;
  const settled = ambient?.settled === true;
  const handledDetailsClicks = useRef(new WeakSet<Event>());

  useEffect(() => {
    if (!hasSelection || settled) return;
    const onClick = (event: MouseEvent) => {
      if (handledDetailsClicks.current.has(event)) return;
      // Sidebar selections share this drawer and must not be dismissed by the same click.
      if (event.target instanceof Element && event.target.closest('[data-testid="chat-session-item"]')) return;
      if (event.target instanceof Element && event.target.closest('[role="menu"], [role="listbox"], [role="dialog"]'))
        return;
      setSelectedId(null);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [hasSelection, settled, setSelectedId]);

  useEffect(() => {
    if (conversationRequest) setSelectedId(null);
  }, [conversationRequest, setSelectedId]);

  useEffect(() => {
    if (!focusAgent) return;
    setSelectedId(focusAgent);
    onFocusAgentConsumed?.();
  }, [focusAgent, setSelectedId]);

  useEffect(() => {
    if (!hasSelection || settled) return;
    // On document, which hears a key before window does, and claimed: the drawer is the topmost
    // thing Escape can close, so the docked conversation beside it (ThreadDock) stays open.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      setSelectedId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [hasSelection, settled, setSelectedId]);

  // The parent waiting on an approval counts too, as it does on the app badge.
  const rosterSummary = summarizeRoster(agents, parent);
  const { total, counts } = rosterSummary;
  const needsYou = counts['needs-you'];
  const parentNeedsYou = parent.status === 'needs-action';
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
          // The ambient line has no pill (its card names only one agent), so it carries the count.
          needsYou > 0 && (settled || !needsYouPill) && `${needsYou} need you`,
          counts.done > 0 && `${counts.done} done`,
          formatRosterCost(rosterSummary),
        ]
          .filter(Boolean)
          .join(' \u00B7 ');

  const quest = useMemo(() => questAgents(agents, report), [agents, report]);
  const finale = useFinale(rootId, quest, parent, report);
  const spend = useRunSpend(rootId, finale.shown);
  const skin = useSkinTheme();
  useApplySkin(skin);
  // Read when the finale shows, so switching skins mid-finale does not replay it. The pack wins over the skin.
  const skinFinale = useRef(skin.sounds.finale);
  skinFinale.current = skin.sounds.finale;
  useEffect(() => {
    if (!finale.shown) return;
    playSoundEvent(
      'finale',
      resolveEventSound('finale', { packSounds: activeSoundPack()?.sounds, skinFinale: skinFinale.current })
    );
  }, [finale.shown]);
  useAgentSoundEvents(agents, parentNeedsYou);

  const parentScene = !split && (view === 'tavern' || view === 'office');
  const bannerInScene = parentScene && renderView !== undefined && agents.length > 0 && !focused;
  const banner = finale.shown && report && (
    <FinaleBanner
      agents={quest}
      spend={presenting ? undefined : spend}
      placement={bannerInScene ? 'scene' : 'inline'}
      look={view === 'office' ? 'office' : 'tavern'}
      onRead={() => {
        finale.dismiss();
        onReadReport?.(report.id);
      }}
      onDismiss={finale.dismiss}
    />
  );

  const detailsInScene =
    (parentScene || (!split && view === 'aquarium')) && renderView !== undefined && agents.length > 0 && !focused;
  const detailsPosition = useAvatarDetailsPosition(selected?.id, detailsInScene && !settled, view);
  const detailsOverlay = selected && (
    // Stay mounted while settled so waking restores the draft and selection.
    <Box
      ref={detailsPosition}
      data-testid="orchestrator-peek-drawer-region"
      sx={{
        position: 'absolute',
        ...(detailsInScene
          ? {
              top: 12,
              left: 12,
              width: 320,
              maxWidth: 'calc(100% - 24px)',
              maxHeight: 'calc(100% - 24px)',
              '& > [data-agent-details-panel]': { maxHeight: 'calc(100cqh - 24px)' },
            }
          : { inset: 12 }),
        zIndex: 400,
        display: settled ? 'none' : 'flex',
        justifyContent: 'flex-end',
        alignItems: 'flex-start',
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <AgentPeekDrawer
        key={selected.id}
        agent={selected}
        persona={(realPersonas ?? personas).get(selected.id)}
        onClose={() => setSelectedId(null)}
        actions={actions}
        skin={detailsInScene ? ORCHESTRATOR_VIEW_INFO[view].detailsSkin : undefined}
        visible={!settled}
      />
    </Box>
  );

  const viewProps: OrchestratorViewProps = {
    agents,
    rootId,
    onSelect: setSelectedId,
    onOpenPr: openPr,
    selectedId,
    introPlaying,
    personas,
    parent,
    onInnkeeperSelect: parentScene ? (onParentToggle ?? onParentFocus) : onParentFocus,
    celebrating: finale.shown,
    sceneOverlay: bannerInScene ? banner : undefined,
    agentDetailsOverlay: detailsInScene ? detailsOverlay : undefined,
    desk,
    settled: ambient?.settled === true,
    restoreAction,
  };

  // A pane pinned to another session draws that session's roster; the stage's selection, drawer, finale and
  // desk stay the active session's, so a click there opens the agent's session instead.
  const renderPane = (pane: OrchestratorPane) => {
    if (!renderView) return null;
    const pinned =
      paneSessions && resolvePaneSession(pane, { activeId: rootId, sessions: paneSessions.sessions, split });
    if (!paneSessions || !pinned) return renderView(pane.view, viewProps);
    return (
      <PinnedPane
        key={pinned.id}
        rootId={pinned.id}
        view={pane.view}
        label={pinLabel(pinned, rootId, paneSessions.sessions, { presenting })}
        source={paneSessions}
        renderView={renderView}
        onOpenSession={actions.open}
        presenting={presenting}
        settled={settled}
      />
    );
  };

  const snapshot = useMemo(
    () => (focused && rootId !== undefined ? toViewSnapshot(rootId, agents, parent, approvals) : undefined),
    [focused, rootId, agents, parent, approvals]
  );
  // The mini window draws from the same (possibly redacted) roster as the views, never the real one.
  const miniWindow = useOrchestrateMiniWindow();
  const miniOpen = miniWindow?.on === true;
  const miniPayload = useMemo(
    () =>
      miniOpen && rootId !== undefined && agents.length > 0
        ? toMiniPayload(toViewSnapshot(rootId, agents, parent), skin, presenting)
        : null,
    [miniOpen, rootId, agents, parent, skin, presenting]
  );
  usePublishOrchestrateMini(miniPayload, miniOpen);

  // Through the same gate a view that does not ship with the app will go through.
  const onViewAction = async (action: ViewAction) => {
    const accepted = snapshot && acceptViewAction(snapshot, action);
    if (!accepted) return;
    await runViewAction(restoreAction ? restoreAction(accepted) : accepted, {
      openAgent: setSelectedId,
      openPr,
      openRoot: () => onParentFocus?.(),
      stop: actions.stop,
    });
  };

  // The parent first: it is the one whose answer everything else is waiting behind.
  const askingAgent = parentNeedsYou ? undefined : firstNeedsYou;
  const needsYouCard = settled && (parentNeedsYou || askingAgent) && (
    <NeedsYouCard
      key={askingAgent?.id ?? 'parent'}
      agent={askingAgent}
      name={
        askingAgent
          ? (personas.get(askingAgent.id)?.label ?? askingAgent.title)
          : view === 'office'
            ? 'The orchestrator'
            : 'The Innkeeper'
      }
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
      data-agent-details-open={hasSelection && !settled ? 'true' : undefined}
      onClickCapture={event => {
        handledDetailsClicks.current.add(event.nativeEvent);
        if (!hasSelection || settled || !(event.target instanceof Element)) return;
        if (!event.currentTarget.contains(event.target)) return;
        if (event.target.closest('[data-agent-details-panel]')) return;
        if (event.target.closest('[data-pr-number], [role="dialog"]')) return;
        setSelectedId(null);
      }}
      data-skin={skin.id ?? 'default'}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        bgcolor: `var(${SKIN_STAGE_VARIABLE}, transparent)`,
        // Joy's type scale reads these, so every Typography under the stage picks the skin's family up.
        ...(skin.fontFamily
          ? { '--joy-fontFamily-body': skin.fontFamily, '--joy-fontFamily-display': skin.fontFamily }
          : {}),
      }}
    >
      {settled ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.5, minWidth: 0 }}>
          {presenting && <PresentingBadge />}
          <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="orchestrator-ambient-status">
            {summary || (view === 'office' ? 'The office is quiet' : 'The tavern is quiet')}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.5, py: 1 }}>
          <ViewSwitcher
            layout={layout}
            onLayoutChange={onLayoutChange}
            ambient={ambient && { on: ambient.on, onToggle: ambient.onToggle }}
            focus={focus}
            presenter={presenter}
            miniWindow={miniWindow}
            paneSessions={paneSessions && { activeId: rootId, sessions: paneSessions.sessions, presenting }}
          />
          {presenting && <PresentingBadge />}
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
      <Box
        data-testid="orchestrator-scene-viewport"
        sx={{ position: 'relative', isolation: 'isolate', display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}
      >
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
              scene={parentScene && renderView ? renderView(view, viewProps) : null}
              office={view === 'office'}
            />
          ) : snapshot ? (
            <FocusPanel snapshot={snapshot} onAction={onViewAction} />
          ) : renderView ? (
            <StageLayout layout={layout} onLayoutChange={onLayoutChange} renderPane={renderPane} />
          ) : (
            <TableView {...viewProps} />
          )}
          {needsYouCard}
        </Box>
        {!detailsInScene && detailsOverlay}
      </Box>
      {prAgent && (
        <AgentPrDialog
          key={prAgent.id}
          sessionId={prAgent.id}
          title={prAgent.title}
          onClose={() => setPrAgentId(null)}
          onOpenLink={onOpenPrLink && (url => onOpenPrLink(prAgent.id, url))}
        />
      )}
    </Box>
  );
}

function PresentingBadge() {
  return (
    <Chip
      size="sm"
      color="primary"
      variant="solid"
      data-testid="orchestrator-presenting-badge"
      title="Presenter mode: titles, activity, questions, PRs, branches and costs are hidden on this stage"
      sx={{ flexShrink: 0 }}
    >
      Presenting
    </Chip>
  );
}

function EmptyStage({ scene, office }: { scene: ReactNode; office: boolean }) {
  if (scene) {
    return (
      <Box
        data-testid="orchestrator-empty-state"
        sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        {scene}
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.25, p: 2 }}>
          <Typography level="body-sm" textColor="text.secondary" textAlign="center">
            {office
              ? 'No agents yet. Describe the work and it will be split across agents.'
              : 'No quests yet. Describe the work and the Innkeeper will split it across agents.'}
          </Typography>
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
        No agents yet. Describe the work and it will be split across agents.
      </Typography>
    </Box>
  );
}
