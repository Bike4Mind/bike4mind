import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import Box from '@mui/joy/Box';
import type { ChatApprovalAnswer } from '@shared/chat';
import type { PendingDecision } from '@shared/pendingDecisions';
import { hostChat } from '../../../host/hostChat';
import { DecisionBody } from '../DecisionCard';
import type { AgentView } from '../roster';
import { useTreeDecisions } from '../useTreeDecisions';
import {
  commandApprovalOf,
  decisionKey,
  dialogueKeyAction,
  dialogueQueue,
  queueIndex,
  reachedEnd,
  SCENE_DIALOGUE_ATTR,
  type CommandApproval,
  type DialogueKeyAction,
} from './dialogue';
import { hueFilter, type SceneArt } from './cast';
import type { AskOutcome } from './sceneAsk';

/** Above sprites and answer bubbles, below the agent details panel (OrchestratorStage, z 400). */
const DIALOGUE_Z = 300;
/** Queue portraits drawn before "+N". */
const QUEUE_PORTRAITS = 5;

type Look = {
  surface: string;
  frame: string;
  inner: string;
  ink: string;
  name: string;
  muted: string;
  codeBg: string;
  codeInk: string;
  gutter: string;
  button: string;
  buttonInk: string;
  keyBg: string;
};

// Dark wood by night, parchment by day; the scene art itself is the same in both.
const WOOD: Look = {
  surface: 'linear-gradient(#2e1f14, #24180f)',
  frame: '#7a5430',
  inner: '#120b06',
  ink: '#f3e6cf',
  name: '#ffd98a',
  muted: '#c9b391',
  codeBg: '#120c07',
  codeInk: '#e9e1d2',
  gutter: '#7d6850',
  button: '#3a2817',
  buttonInk: '#f3e6cf',
  keyBg: '#1a110a',
};

const PARCHMENT: Look = {
  surface: 'linear-gradient(#f5e8c8, #ecd9ad)',
  frame: '#8b6a3d',
  inner: '#5a3d1e',
  ink: '#3b2a17',
  name: '#7a3d10',
  muted: '#6b5538',
  codeBg: '#fffaf0',
  codeInk: '#2b2015',
  gutter: '#9c8462',
  button: '#f8eed6',
  buttonInk: '#3b2a17',
  keyBg: '#efe0bb',
};

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SceneDialogueProps {
  agents: readonly AgentView[];
  nameOf(sessionId: string): string;
  portraitOf(sessionId: string): SceneArt | undefined;
  /** The request at the front, by decisionKey or session id (queueIndex); the queue's head when unset or gone. */
  frontKey: string | undefined;
  onFrontChange(key: string | undefined): void;
  /**
   * Each session's front request in the box, so the scene can show it over the agent and send a click on
   * any other waiting agent elsewhere.
   */
  onAsksChange?(asks: ReadonlyMap<string, PendingDecision>): void;
  /** A request answered in this box, and how. */
  onAnswered?(decision: PendingDecision, outcome: Exclude<AskOutcome, 'elsewhere'>): void;
  onOpenDetails(sessionId: string): void;
  /** Bumped to bring the box forward and focus it (the stage's "N need you" pill). */
  focusRequest?: number;
  look: 'wood' | 'parchment';
}

/**
 * Every request the scene's agents are waiting on, asked by the agent itself in a dialogue box over the
 * lower part of the scene. It replaces the stage's Needs-you strip and the answer bubbles while the scene
 * is the only view, so each request has exactly one place to be answered. Every answer goes through the
 * same first-wins IPC as the conversation's own cards (respondToApproval and DecisionBody's calls).
 *
 * A plain command approval is drawn in the box's own style and can be answered by key; anything else
 * (a diff, a choice, an irreversible call, a question, a relay, a failed turn) keeps the thread's own card
 * inside the box, so nothing that card says is restyled away.
 */
export function SceneDialogue({
  agents,
  nameOf,
  portraitOf,
  frontKey,
  onFrontChange,
  onAsksChange,
  onAnswered,
  onOpenDetails,
  focusRequest,
  look,
}: SceneDialogueProps) {
  const { byId, loadError, refresh } = useTreeDecisions(agents);
  // Answered here and gone at once, rather than waiting on the refetch.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [minimized, setMinimized] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // The front command's own handler for A / C / D / E, so the keys work wherever focus is in the box.
  const commandKeys = useRef<CommandKeys | undefined>(undefined);
  const queue = dialogueQueue(byId).filter(decision => !answered.has(decisionKey(decision)));
  const index = queueIndex(queue, frontKey);
  const front = queue[index] as PendingDecision | undefined;
  const asksKey = queue.map(decisionKey).join('\n');
  const latestQueue = useRef(queue);
  latestQueue.current = queue;
  useEffect(() => {
    const asks = new Map<string, PendingDecision>();
    for (const decision of latestQueue.current)
      if (!asks.has(decision.sessionId)) asks.set(decision.sessionId, decision);
    onAsksChange?.(asks);
  }, [asksKey, onAsksChange]);

  // A focus request un-minimizes the box, then focuses it once it is back on screen.
  const focusPending = useRef(false);
  useEffect(() => {
    if (!focusRequest) return;
    focusPending.current = true;
    setMinimized(false);
  }, [focusRequest]);
  useEffect(() => {
    if (!focusPending.current || minimized || !boxRef.current) return;
    focusPending.current = false;
    boxRef.current.focus();
  });

  if (!front) {
    return loadError ? (
      <Box data-testid="scene-dialogue-error" role="alert" sx={tabSx(look)}>
        {loadError}
      </Box>
    ) : null;
  }

  const colors = look === 'wood' ? WOOD : PARCHMENT;
  const name = nameOf(front.sessionId);
  const move = (step: number) => {
    if (queue.length < 2) return;
    onFrontChange(decisionKey(queue[(index + step + queue.length) % queue.length]));
  };
  const settle = (decision: PendingDecision, outcome: Exclude<AskOutcome, 'elsewhere'>) => {
    onAnswered?.(decision, outcome);
    setAnswered(previous => new Set(previous).add(decisionKey(decision)));
    refresh();
  };

  if (minimized) {
    return (
      <Box
        component="button"
        type="button"
        data-testid="scene-dialogue-minimized"
        onClick={() => setMinimized(false)}
        sx={{ ...tabSx(look), cursor: 'pointer', font: 'inherit' }}
      >
        <strong>{name}</strong>
        {` needs you${queue.length > 1 ? ` \u00b7 ${queue.length} waiting` : ''}`}
      </Box>
    );
  }

  return (
    <Box
      ref={boxRef}
      role="region"
      aria-label={`${name} needs you`}
      aria-keyshortcuts="A C D O E ArrowLeft ArrowRight Escape"
      tabIndex={-1}
      {...{ [SCENE_DIALOGUE_ATTR]: '' }}
      data-testid="scene-dialogue"
      data-look={look}
      data-kind={front.kind}
      onKeyDown={event => {
        if (isEditable(event.target)) return;
        const action = dialogueKeyAction(event);
        if (action === 'next' || action === 'previous') {
          event.preventDefault();
          move(action === 'next' ? 1 : -1);
        } else if (action === 'minimize') {
          event.preventDefault();
          setMinimized(true);
        } else if (action === 'open') {
          event.preventDefault();
          onOpenDetails(front.sessionId);
        } else if (action && commandKeys.current?.(action)) {
          event.preventDefault();
        }
      }}
      sx={{
        position: 'absolute',
        left: '2%',
        right: '2%',
        bottom: '3%',
        zIndex: DIALOGUE_Z,
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        gap: '1.2cqw',
        maxHeight: '94%',
        p: '1cqh 1.4cqw',
        background: colors.surface,
        color: colors.ink,
        border: `3px solid ${colors.inner}`,
        borderRadius: '4px',
        boxShadow: `inset 0 0 0 2px ${colors.frame}, 0 10px 30px rgba(0, 0, 0, 0.55)`,
        fontSize: 'clamp(11px, 2.2cqh, 14px)',
        lineHeight: 1.4,
        pointerEvents: 'auto',
        '&:focus-visible': { outline: '2px solid #f5c542', outlineOffset: 2 },
        // A narrow scene has no lower third to spare: the box takes the whole picture and scrolls.
        '@container (max-width: 640px)': { left: 0, right: 0, bottom: 0, top: 0, maxHeight: 'none' },
      }}
    >
      <Portrait art={portraitOf(front.sessionId)} colors={colors} />
      <Box sx={{ minWidth: 0, overflowY: 'auto', overscrollBehavior: 'contain', pr: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: '0.6em', flexWrap: 'wrap' }}>
          <Box
            component="span"
            data-testid="scene-dialogue-name"
            sx={{ font: '700 1.15em/1.2 Georgia, serif', color: colors.name }}
          >
            {name}
          </Box>
          <Box component="span" sx={{ fontSize: '0.85em', color: colors.muted }}>
            {askOf(front)}
          </Box>
          {queue.length > 1 && (
            <QueueNav
              queue={queue}
              index={index}
              portraitOf={portraitOf}
              nameOf={nameOf}
              colors={colors}
              onPick={key => onFrontChange(key)}
              onMove={move}
            />
          )}
        </Box>
        {/* Keyed on the request so expansion, the read gate and any error never carry to the next one. */}
        <FrontBody
          key={decisionKey(front)}
          decision={front}
          name={name}
          colors={colors}
          onOpenDetails={onOpenDetails}
          onSettled={outcome => settle(front, outcome)}
          onRefresh={refresh}
          commandKeys={commandKeys}
        />
      </Box>
    </Box>
  );
}

function askOf(decision: PendingDecision): string {
  switch (decision.kind) {
    case 'approval':
      return commandApprovalOf(decision)?.ask ?? 'needs your approval';
    case 'question':
      return 'has a question for you';
    case 'held-relay':
      return 'is holding a message for you';
    case 'stopped':
      return 'paused before finishing';
    case 'error':
      return 'hit an error';
  }
}

function tabSx(look: 'wood' | 'parchment') {
  const colors = look === 'wood' ? WOOD : PARCHMENT;
  return {
    position: 'absolute',
    left: '2%',
    bottom: '3%',
    zIndex: DIALOGUE_Z,
    px: '0.9em',
    py: '0.35em',
    background: colors.surface,
    color: colors.ink,
    border: `2px solid ${colors.inner}`,
    borderRadius: '4px',
    boxShadow: `inset 0 0 0 1px ${colors.frame}`,
    fontSize: 'clamp(11px, 2.2cqh, 14px)',
    pointerEvents: 'auto',
  } as const;
}

/**
 * The art as a background. A tinted sprite gets a layer of its own, since a filter on the box would tint
 * its frame too; untinted art stays on the box, under the frame's inset edge.
 */
function artBackground(art: SceneArt | undefined, size: string, position: string, repeat?: 'no-repeat') {
  if (!art) return {};
  const image = {
    backgroundImage: `url("${art.src}")`,
    backgroundSize: size,
    backgroundPosition: position,
    backgroundRepeat: repeat,
    imageRendering: 'pixelated',
  } as const;
  if (!art.hue) return image;
  return {
    position: 'relative',
    '&::before': { content: '""', position: 'absolute', inset: 0, ...image, filter: hueFilter(art) },
  } as const;
}

function Portrait({ art, colors }: { art: SceneArt | undefined; colors: Look }) {
  return (
    <Box
      aria-hidden
      data-testid="scene-dialogue-portrait"
      sx={{
        width: 'clamp(48px, 13cqh, 96px)',
        aspectRatio: '1',
        border: `2px solid ${colors.frame}`,
        boxShadow: `inset 0 0 0 2px ${colors.inner}`,
        backgroundColor: 'rgba(0, 0, 0, 0.18)',
        ...artBackground(art, '125%', 'center 85%', 'no-repeat'),
      }}
    />
  );
}

function QueueNav({
  queue,
  index,
  portraitOf,
  nameOf,
  colors,
  onPick,
  onMove,
}: {
  queue: readonly PendingDecision[];
  index: number;
  portraitOf(sessionId: string): SceneArt | undefined;
  nameOf(sessionId: string): string;
  colors: Look;
  onPick(key: string): void;
  onMove(step: number): void;
}) {
  // Slide the window so the front request's portrait is always one of those shown.
  const start = Math.max(0, Math.min(index - QUEUE_PORTRAITS + 1, queue.length - QUEUE_PORTRAITS));
  const shown = queue.slice(start, start + QUEUE_PORTRAITS);
  const arrowSx = { ...choiceSx(colors), px: '0.45em' };
  return (
    <Box
      data-testid="scene-dialogue-queue"
      sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: '0.3em', fontSize: '0.85em', color: colors.muted }}
    >
      <Box component="button" type="button" aria-label="Previous request" onClick={() => onMove(-1)} sx={arrowSx}>
        {'\u2039'}
      </Box>
      {shown.map((decision, position) => {
        const art = portraitOf(decision.sessionId);
        const current = start + position === index;
        return (
          <Box
            key={decisionKey(decision)}
            component="button"
            type="button"
            aria-label={`${nameOf(decision.sessionId)}'s request`}
            aria-current={current || undefined}
            onClick={() => onPick(decisionKey(decision))}
            sx={{
              width: '1.9em',
              height: '1.9em',
              p: 0,
              cursor: 'pointer',
              border: `2px solid ${current ? '#f5c542' : colors.frame}`,
              borderRadius: '3px',
              opacity: current ? 1 : 0.65,
              backgroundColor: 'rgba(0, 0, 0, 0.2)',
              ...artBackground(art, '140%', 'center 90%'),
            }}
          />
        );
      })}
      {queue.length > shown.length && <span>{`+${queue.length - shown.length}`}</span>}
      <span data-testid="scene-dialogue-position">{`${index + 1} of ${queue.length}`}</span>
      <Box component="button" type="button" aria-label="Next request" onClick={() => onMove(1)} sx={arrowSx}>
        {'\u203a'}
      </Box>
    </Box>
  );
}

function choiceSx(colors: Look, tone: 'plain' | 'primary' | 'deny' = 'plain') {
  const primary = tone === 'primary';
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.45em',
    font: 'inherit',
    fontSize: '0.92em',
    lineHeight: 1.2,
    px: '0.75em',
    py: '0.3em',
    cursor: 'pointer',
    borderRadius: '3px',
    border: `2px solid ${primary ? '#9cc0ff' : tone === 'deny' ? '#a2523f' : colors.frame}`,
    bgcolor: primary ? '#2f6fe0' : colors.button,
    color: primary ? '#fff' : colors.buttonInk,
    '&:focus-visible': { outline: '2px solid #f5c542', outlineOffset: 2 },
    '&:disabled': { opacity: 0.45, cursor: 'default' },
  } as const;
}

function Key({ children, colors }: { children: string; colors: Look }) {
  return (
    <Box
      component="kbd"
      aria-hidden
      sx={{
        font: '700 0.78em/1 ui-monospace, Menlo, monospace',
        px: '0.35em',
        py: '0.2em',
        borderRadius: '3px',
        border: `1px solid ${colors.frame}`,
        bgcolor: colors.keyBg,
        color: colors.buttonInk,
      }}
    >
      {children}
    </Box>
  );
}

/** Runs a key's action on the front command; false when the key means nothing to it. */
type CommandKeys = (action: DialogueKeyAction) => boolean;

function FrontBody({
  decision,
  name,
  colors,
  onOpenDetails,
  onSettled,
  onRefresh,
  commandKeys,
}: {
  decision: PendingDecision;
  name: string;
  colors: Look;
  onOpenDetails(sessionId: string): void;
  /** This request was answered here. */
  onSettled(outcome: Exclude<AskOutcome, 'elsewhere'>): void;
  /** Something changed that may have closed it; read again. */
  onRefresh(): void;
  commandKeys: MutableRefObject<CommandKeys | undefined>;
}) {
  const command = commandApprovalOf(decision);
  if (command) {
    return (
      <CommandAsk
        sessionId={decision.sessionId}
        command={command}
        colors={colors}
        onOpen={() => onOpenDetails(decision.sessionId)}
        onSettled={onSettled}
        commandKeys={commandKeys}
      />
    );
  }
  return (
    <Box data-testid="scene-dialogue-card" sx={{ mt: '0.5em' }}>
      <DecisionBody
        decision={decision}
        asker={{ name, path: [name] }}
        onOpenDetails={onOpenDetails}
        onSettled={onRefresh}
        onAnswered={onSettled}
      />
      <Box sx={{ mt: '0.5em' }}>
        <Box
          component="button"
          type="button"
          data-testid="scene-dialogue-open"
          onClick={() => onOpenDetails(decision.sessionId)}
          sx={choiceSx(colors)}
        >
          Open session <Key colors={colors}>O</Key>
        </Box>
      </Box>
    </Box>
  );
}

/** Lines of the command the box shows before it scrolls, in em of its own text. */
const COLLAPSED_CODE_EM = 7.5;

function CommandAsk({
  sessionId,
  command,
  colors,
  onOpen,
  onSettled,
  commandKeys,
}: {
  sessionId: string;
  command: CommandApproval;
  colors: Look;
  onOpen(): void;
  onSettled(outcome: 'approved' | 'denied'): void;
  commandKeys: MutableRefObject<CommandKeys | undefined>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [read, setRead] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const lines = command.text.split('\n');
  const canAllow = read && !sending;

  const checkRead = () => {
    const code = codeRef.current;
    if (code && reachedEnd(code)) setRead(true);
  };
  // A command that fits is read as soon as it is on screen; a longer one once scrolled or expanded.
  useLayoutEffect(checkRead, [expanded]);

  const respond = async (answer: ChatApprovalAnswer) => {
    setSending(true);
    setError(null);
    try {
      await hostChat.respondToApproval(sessionId, command.approvalId, answer);
      onSettled(answer.decision === 'deny' ? 'denied' : 'approved');
    } catch (caught) {
      setError(errorText(caught));
      setSending(false);
    }
  };

  const run = (action: DialogueKeyAction): boolean => {
    switch (action) {
      case 'once':
        if (canAllow) void respond({ decision: 'once' });
        return true;
      case 'chat':
        if (canAllow && command.allowInChat) void respond({ decision: 'always' });
        return true;
      case 'deny':
        if (!sending) void respond({ decision: 'deny' });
        return true;
      case 'expand':
        setExpanded(value => !value);
        return true;
      default:
        return false;
    }
  };
  // In layout effects, not render: on a swap the old command's unmount clears first, then the new one binds.
  useLayoutEffect(() => {
    commandKeys.current = run;
  });
  useLayoutEffect(
    () => () => {
      commandKeys.current = undefined;
    },
    [commandKeys]
  );

  return (
    <Box data-testid="scene-dialogue-command">
      {command.description && (
        <Box
          data-testid="scene-dialogue-description"
          sx={{ font: 'italic 1em/1.35 Georgia, serif', mt: '0.2em', overflowWrap: 'anywhere' }}
        >
          {`"${command.description}"`}
        </Box>
      )}
      <Box
        ref={codeRef}
        tabIndex={0}
        role="region"
        aria-label="Command"
        data-testid="scene-dialogue-code"
        onScroll={checkRead}
        sx={{
          mt: '0.4em',
          maxHeight: expanded ? 'none' : `${COLLAPSED_CODE_EM}em`,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          py: '0.3em',
          bgcolor: colors.codeBg,
          color: colors.codeInk,
          border: `1px solid ${colors.frame}`,
          borderRadius: '3px',
          font: '0.88em/1.5 ui-monospace, "SF Mono", Menlo, monospace',
          '&:focus-visible': { outline: '2px solid #f5c542', outlineOffset: 1 },
        }}
      >
        {lines.map((line, lineIndex) => (
          <Box key={lineIndex} sx={{ display: 'flex' }}>
            <Box
              component="span"
              aria-hidden
              sx={{ flex: '0 0 2.6em', textAlign: 'right', pr: '0.8em', color: colors.gutter, userSelect: 'none' }}
            >
              {lineIndex + 1}
            </Box>
            <Box component="span" sx={{ flex: 1, pr: '0.8em', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {line}
            </Box>
          </Box>
        ))}
      </Box>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 1,
          mt: '0.2em',
          fontSize: '0.8em',
          color: colors.muted,
        }}
      >
        <span>{`${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}</span>
        <Box
          component="button"
          type="button"
          data-testid="scene-dialogue-expand"
          onClick={() => setExpanded(value => !value)}
          sx={{ font: 'inherit', color: 'inherit', bgcolor: 'transparent', border: 0, p: 0, cursor: 'pointer' }}
        >
          {expanded ? 'Collapse' : 'Show all'} <Key colors={colors}>E</Key>
        </Box>
      </Box>
      {error && (
        <Box data-testid="scene-dialogue-error" role="alert" sx={{ mt: '0.3em', color: '#e0705a' }}>
          {error}
        </Box>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.4em', mt: '0.5em' }}>
        <Box
          component="button"
          type="button"
          disabled={!canAllow}
          onClick={() => run('once')}
          data-testid="scene-dialogue-allow-once"
          sx={choiceSx(colors, 'primary')}
        >
          Allow once <Key colors={colors}>A</Key>
        </Box>
        {command.allowInChat && (
          <Box
            component="button"
            type="button"
            disabled={!canAllow}
            onClick={() => run('chat')}
            data-testid="scene-dialogue-allow-chat"
            sx={choiceSx(colors)}
          >
            Allow in this chat <Key colors={colors}>C</Key>
          </Box>
        )}
        <Box
          component="button"
          type="button"
          disabled={sending}
          onClick={() => run('deny')}
          data-testid="scene-dialogue-deny"
          sx={choiceSx(colors, 'deny')}
        >
          {"Don't run"} <Key colors={colors}>D</Key>
        </Box>
        <Box component="button" type="button" onClick={onOpen} data-testid="scene-dialogue-open" sx={choiceSx(colors)}>
          Open session <Key colors={colors}>O</Key>
        </Box>
        {!read && (
          <Box component="span" data-testid="scene-dialogue-read-gate" sx={{ fontSize: '0.85em', color: colors.muted }}>
            Read to the end to allow
          </Box>
        )}
      </Box>
      {command.allowInChat && (
        <Box
          data-testid="scene-dialogue-scope"
          sx={{ mt: '0.35em', fontSize: '0.8em', color: colors.muted, overflowWrap: 'anywhere' }}
        >
          {command.scope
            ? `"Allow in this chat" covers ${command.scope} for the rest of this agent's conversation.`
            : `"Allow in this chat" applies for the rest of this agent's conversation.`}
          {command.moreInDetails && ' More choices in Open session.'}
        </Box>
      )}
    </Box>
  );
}
