import { useEffect, useId, useRef, type ComponentProps, type ReactNode, type RefObject } from 'react';
import Box from '@mui/joy/Box';
import Divider from '@mui/joy/Divider';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import type { ChatProject } from '@shared/chat';
import type { PrBarState } from '@shared/pullRequest';
import { countTodos, type TodoItem } from '@shared/todos';
import type { WorkspaceChanges } from '@shared/workspaceChanges';
import { ChangesBar, CreatePullRequestButton } from './ChangesBar';
import { ContextBreakdown } from './ContextBreakdown';
import { DiffCount } from './DiffCount';
import { CloseIcon, DisclosureIcon } from './icons';
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
  /** Docked beside the thread, or opened over it from the header button when the region is narrow. */
  variant: 'docked' | 'overlay';
  collapsed: ReadonlySet<SessionPanelSectionId>;
  onToggleSection: (id: SessionPanelSectionId) => void;
  /** Overlay only: shut it on Escape, a click outside, or its close button. */
  onDismiss?: () => void;
  /** Overlay only: the element that opened it, whose own click must not count as outside, and
   * where focus goes back to when it shuts. */
  anchor?: RefObject<HTMLElement | null>;
  environment: {
    project: ChatProject | undefined;
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

function environmentSection({ environment }: SessionPanelProps): SectionSpec | null {
  if (!environment.project) return null;
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
  if (background.processes.length === 0 && background.spawned.length === 0 && !background.loop) return null;
  return {
    id: 'background',
    title: 'Background tasks',
    summary: <SummaryText>{backgroundSummary(background.processes, background.spawned, background.loop)}</SummaryText>,
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
      event.preventDefault();
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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside the card while it is modal: focus moves in when it opens, wraps at either end,
 * and goes back to the anchor when it shuts.
 */
function useFocusTrap(card: RefObject<HTMLElement | null>, active: boolean, anchor?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = card.current;
    if (!active || !node) return;
    const focusables = () => [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
    (focusables()[0] ?? node).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      // A menu the card opened is portalled out of it and handles its own Tab.
      if (event.target instanceof Element && event.target.closest('[role="menu"], [role="listbox"]')) return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      const inside = current instanceof Node && node.contains(current);
      if (!first || !last) {
        event.preventDefault();
        node.focus();
      } else if (event.shiftKey && (!inside || current === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || current === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Passive cleanup runs after the card left the DOM, so focus that was in it has fallen to the
      // body. A card that only docked keeps its focus, and a click elsewhere keeps where it landed.
      const current = document.activeElement;
      if (!current || current === document.body) anchor?.current?.focus();
    };
  }, [card, active, anchor]);
}

const overlayIn = keyframes({
  from: { opacity: 0, transform: 'translateY(-4px)' },
  to: { opacity: 1, transform: 'none' },
});
const scrimIn = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const OVERLAY_ENTER = '140ms ease-out';

/**
 * A Code session's status in one floating card over the top-right of the thread: where it runs,
 * what it has changed or the PR it opened, the plan, and what it has running in the background.
 *
 * Positioned against the thread region (see ChatShell), never the whole column, so it cannot reach
 * the composer; ChatShell docks it while the region has room (sessionPanelLayout) and otherwise
 * opens it from the header button as a modal overlay over a light scrim.
 */
export function SessionPanel(props: SessionPanelProps) {
  const { variant, collapsed, onToggleSection, onDismiss, anchor } = props;
  const card = useRef<HTMLDivElement | null>(null);
  const overlay = variant === 'overlay';
  useDismiss(card, overlay ? onDismiss : undefined, anchor);
  useFocusTrap(card, overlay, anchor);

  const sections = SESSION_PANEL_SECTIONS.map(id => SECTION_BUILDERS[id](props)).filter(
    (section): section is SectionSpec => !!section
  );

  const panel = (
    <Box
      ref={card}
      id={SESSION_PANEL_ID}
      role={overlay ? 'dialog' : 'complementary'}
      aria-modal={overlay || undefined}
      aria-label="Session"
      tabIndex={overlay ? -1 : undefined}
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
        boxShadow: overlay ? 'lg' : 'sm',
        zIndex: overlay ? 'popup' : 'table',
        outline: 'none',
        ...(overlay && {
          animation: `${overlayIn} ${OVERLAY_ENTER}`,
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }),
        ...thinScrollbarSx,
      }}
      data-testid="session-panel"
      data-variant={variant}
    >
      {overlay && onDismiss && (
        <>
          <Stack direction="row" alignItems="center" sx={{ pl: 1.5, pr: 0.75, py: 0.5 }}>
            <Typography level="body-xs" fontWeight="lg" textColor="text.secondary" sx={{ flex: 1 }}>
              Session
            </Typography>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              aria-label="Close the session panel"
              onClick={onDismiss}
              data-testid="session-panel-close-btn"
              sx={{ '--IconButton-size': '28px' }}
            >
              <CloseIcon />
            </IconButton>
          </Stack>
          <Divider />
        </>
      )}
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
  if (!overlay) return panel;
  return (
    <>
      {/* Presses on it count as outside the card, so useDismiss shuts the overlay. */}
      <Box
        aria-hidden
        data-testid="session-panel-scrim"
        sx={{
          position: 'absolute',
          inset: 0,
          bgcolor: 'background.backdrop',
          zIndex: 'popup',
          animation: `${scrimIn} ${OVERLAY_ENTER}`,
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }}
      />
      {panel}
    </>
  );
}
