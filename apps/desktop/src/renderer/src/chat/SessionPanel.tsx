import { useEffect, useId, useRef, type ComponentProps, type ReactNode, type RefObject } from 'react';
import Box from '@mui/joy/Box';
import Divider from '@mui/joy/Divider';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatProject } from '@shared/chat';
import type { PrBarState } from '@shared/pullRequest';
import { countTodos, type TodoItem } from '@shared/todos';
import type { WorkspaceChanges } from '@shared/workspaceChanges';
import { ChangesBar, CreatePullRequestButton } from './ChangesBar';
import { ContextBreakdown } from './ContextBreakdown';
import { DiffCount } from './DiffCount';
import { DisclosureIcon } from './icons';
import { thinScrollbarSx } from './layout';
import { PrHeadline, PrStatusBar } from './PrStatusBar';
import { SessionChips } from './SessionChips';
import { BackgroundSection, backgroundSummary, type BackgroundSectionProps } from './SessionPanelBackground';
import {
  SESSION_PANEL_INSET,
  SESSION_PANEL_SECTIONS,
  SESSION_PANEL_WIDTH,
  type SessionPanelSectionId,
} from './sessionPanelState';
import { contextPercent, formatOccupancy, formatTokens, type ComposerUsage } from './statusLine';
import { TodoList, visiblePlan } from './TodoPanel';
import type { ProjectBindingController } from './useChat';

/** The card's DOM id, for the header toggle's aria-controls. */
export const SESSION_PANEL_ID = 'chat-session-panel';

const focusRingSx = {
  '&:focus-visible': { outline: '2px solid var(--joy-palette-focusVisible)', outlineOffset: '-2px' },
} as const;

interface SectionSpec {
  id: SessionPanelSectionId;
  title: string;
  /** Drawn in the header while the section is folded, so its figures stay on screen. */
  summary?: ReactNode;
  /** Controls beside the header, outside its toggle, reachable whether or not it is folded. */
  actions?: ReactNode;
  content: ReactNode;
}

function PanelSection({
  section,
  expanded,
  onToggle,
}: {
  section: SectionSpec;
  expanded: boolean;
  onToggle: () => void;
}) {
  const bodyId = useId();
  return (
    <Box component="section" aria-label={section.title} data-testid={`session-panel-section-${section.id}`}>
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ px: 0.75, py: 0.5, minWidth: 0 }}>
        <Box
          component="button"
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
          sx={{
            all: 'unset',
            boxSizing: 'border-box',
            flex: 1,
            minWidth: 0,
            minHeight: 28,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: 0.75,
            borderRadius: 'sm',
            cursor: 'pointer',
            '&:hover': { bgcolor: 'neutral.plainHoverBg' },
            ...focusRingSx,
          }}
          data-testid={`session-panel-${section.id}-toggle-btn`}
        >
          <Typography level="body-xs" fontWeight="lg" textColor="text.secondary" noWrap sx={{ flexShrink: 0 }}>
            {section.title}
          </Typography>
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'flex-end', overflow: 'hidden' }}>
            {!expanded && section.summary}
          </Box>
          <Box sx={{ display: 'flex', color: 'text.tertiary', flexShrink: 0 }}>
            <DisclosureIcon open={expanded} />
          </Box>
        </Box>
        {section.actions}
      </Stack>
      {expanded && (
        <Box id={bodyId} sx={{ px: 1.5, pb: 1.25, minWidth: 0 }} data-testid={`session-panel-${section.id}-body`}>
          {section.content}
        </Box>
      )}
    </Box>
  );
}

function SummaryText({ children }: { children: ReactNode }) {
  return (
    <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ minWidth: 0 }}>
      {children}
    </Typography>
  );
}

export interface SessionPanelProps {
  /** Docked beside the thread, or opened over it from the header button on a narrow window. */
  variant: 'docked' | 'popover';
  collapsed: ReadonlySet<SessionPanelSectionId>;
  onToggleSection: (id: SessionPanelSectionId) => void;
  /** Popover only: shut it on Escape or a click outside. */
  onDismiss?: () => void;
  /** Popover only: the element that opened it, whose own click must not count as outside. */
  anchor?: RefObject<HTMLElement | null>;
  environment: {
    project: ChatProject;
    grantedDirectories?: readonly string[];
    binding: ProjectBindingController;
    settledTurns: number;
    inUse: boolean;
    preparing: boolean;
  };
  changes: {
    workspace: WorkspaceChanges | null;
    /** This session has a PR, whether or not its section was dismissed; see ChatShell. */
    hasPullRequest: boolean;
    pullRequest: PrBarState | null;
    pullRequestActions: Omit<ComponentProps<typeof PrStatusBar>, 'state'>;
    /** A reply is running; see CreatePullRequestButton. */
    busy: boolean;
    onCreatePullRequest: (changes: WorkspaceChanges) => void;
  };
  /** The same figures the composer's usage ring draws; see ComposerUsage. */
  context: ComposerUsage;
  plan: { todos: readonly TodoItem[] | null; turnOpen: boolean };
  background: BackgroundSectionProps;
}

function environmentSection({ environment }: SessionPanelProps): SectionSpec {
  return {
    id: 'environment',
    title: 'Environment',
    summary: <SummaryText>{environment.project.name}</SummaryText>,
    content: (
      <SessionChips
        layout="panel"
        project={environment.project}
        {...(environment.grantedDirectories ? { grantedDirectories: environment.grantedDirectories } : {})}
        binding={environment.binding}
        settledTurns={environment.settledTurns}
        inUse={environment.inUse}
        preparing={environment.preparing}
      />
    ),
  };
}

function contextSection({ context }: SessionPanelProps): SectionSpec | null {
  const tokens = context.contextSnapshot?.inputTokens ?? context.contextTokens;
  const percent = contextPercent(tokens, context.contextLimit);
  const share =
    tokens === null
      ? 'Not measured'
      : percent === null
        ? `${formatTokens(tokens)} used`
        : formatOccupancy(percent, tokens);
  return {
    id: 'context',
    title: 'Context',
    summary: <SummaryText>{share}</SummaryText>,
    content: <ContextBreakdown context={context} />,
  };
}

/** The PR once there is one, the working-directory changes until then; never both. */
function changesSection({ changes }: SessionPanelProps): SectionSpec | null {
  if (changes.hasPullRequest) {
    const pullRequest = changes.pullRequest;
    if (!pullRequest?.binding) return null;
    return {
      id: 'changes',
      title: 'Pull request',
      summary: <PrHeadline state={pullRequest} />,
      content: <PrStatusBar state={pullRequest} {...changes.pullRequestActions} />,
    };
  }
  const workspace = changes.workspace;
  if (!workspace) return null;
  return {
    id: 'changes',
    title: 'Changes',
    summary: <DiffCount added={workspace.added} removed={workspace.removed} testId="session-panel-changes-summary" />,
    actions: (
      <CreatePullRequestButton
        changes={workspace}
        busy={changes.busy}
        onCreatePullRequest={changes.onCreatePullRequest}
      />
    ),
    content: <ChangesBar changes={workspace} />,
  };
}

function planSection({ plan }: SessionPanelProps): SectionSpec | null {
  const todos = visiblePlan(plan.todos, plan.turnOpen);
  if (!todos) return null;
  return {
    id: 'plan',
    title: 'Plan',
    summary: <SummaryText>{`${countTodos(todos).completed}/${todos.length}`}</SummaryText>,
    content: <TodoList todos={todos} />,
  };
}

function backgroundSection({ background }: SessionPanelProps): SectionSpec | null {
  if (background.processes.length === 0 && background.spawned.length === 0) return null;
  return {
    id: 'background',
    title: 'Background tasks',
    summary: <SummaryText>{backgroundSummary(background.processes, background.spawned)}</SummaryText>,
    content: <BackgroundSection {...background} />,
  };
}

/**
 * One builder per section, drawn in SESSION_PANEL_SECTIONS order; a builder returns null when it
 * has nothing to say, and that section is left out.
 */
const SECTION_BUILDERS: Record<SessionPanelSectionId, (props: SessionPanelProps) => SectionSpec | null> = {
  environment: environmentSection,
  context: contextSection,
  changes: changesSection,
  plan: planSection,
  background: backgroundSection,
};

/** Escape, or a press outside the card that is not on its anchor or in a menu it opened. */
function useDismiss(
  card: RefObject<HTMLElement | null>,
  onDismiss?: () => void,
  anchor?: RefObject<HTMLElement | null>
) {
  useEffect(() => {
    if (!onDismiss) return;
    const ownsTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      if (card.current?.contains(target) || anchor?.current?.contains(target)) return true;
      // The chips' menus and tooltips are portalled to the body, so a click in one is not "outside".
      return target instanceof Element && !!target.closest('[role="menu"], [role="listbox"], [role="tooltip"]');
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ownsTarget(event.target)) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [card, anchor, onDismiss]);
}

/**
 * A Code session's status in one floating card over the top-right of the thread: where it runs,
 * what it has changed or the PR it opened, the plan, and what it has running in the background.
 *
 * Positioned against the thread region (see ChatShell), never the whole column, so it cannot reach
 * the composer; ChatShell docks it only when it fits beside the reading column
 * (panelFitsBesideThread) and otherwise opens it as a popover from the header button.
 */
export function SessionPanel(props: SessionPanelProps) {
  const { variant, collapsed, onToggleSection, onDismiss, anchor } = props;
  const card = useRef<HTMLDivElement | null>(null);
  useDismiss(card, variant === 'popover' ? onDismiss : undefined, anchor);

  const sections = SESSION_PANEL_SECTIONS.map(id => SECTION_BUILDERS[id](props)).filter(
    (section): section is SectionSpec => !!section
  );

  return (
    <Box
      ref={card}
      id={SESSION_PANEL_ID}
      role="complementary"
      aria-label="Session"
      sx={{
        position: 'absolute',
        top: SESSION_PANEL_INSET,
        right: SESSION_PANEL_INSET,
        width: SESSION_PANEL_WIDTH,
        maxWidth: `calc(100% - ${2 * SESSION_PANEL_INSET}px)`,
        maxHeight: `calc(100% - ${2 * SESSION_PANEL_INSET}px)`,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        bgcolor: 'background.surface',
        border: '1px solid',
        borderColor: 'neutral.outlinedBorder',
        borderRadius: 'md',
        boxShadow: variant === 'popover' ? 'lg' : 'sm',
        zIndex: variant === 'popover' ? 'popup' : 'table',
        ...thinScrollbarSx,
      }}
      data-testid="session-panel"
      data-variant={variant}
    >
      {sections.map((section, index) => (
        <Box key={section.id}>
          {index > 0 && <Divider />}
          <PanelSection
            section={section}
            expanded={!collapsed.has(section.id)}
            onToggle={() => onToggleSection(section.id)}
          />
        </Box>
      ))}
    </Box>
  );
}
