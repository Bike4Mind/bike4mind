import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useShallow } from 'zustand/react/shallow';
import { useCliStore, selectActiveBackgroundShells, selectCompletedBackgroundShells } from '../store';
import type { ShellSession, ShellSessionStatus } from '@bike4mind/services/llm/tools/cliTools';

/** How long a finished session lingers in the indicator before it auto-clears. */
const COMPLETED_DISPLAY_MS = 4000;

const MAX_COMMAND_LENGTH = 60;

type TerminalShellStatus = Exclude<ShellSessionStatus, 'running'>;

const TERMINAL_ICON: Record<TerminalShellStatus, { symbol: string; color: string }> = {
  exited: { symbol: '✔', color: 'green' }, // check
  killed: { symbol: '✕', color: 'yellow' }, // x
  timed_out: { symbol: '⏱', color: 'yellow' }, // stopwatch
};

function elapsedSeconds(session: ShellSession): number {
  return Math.round(((session.endTime ?? Date.now()) - session.startTime) / 1000);
}

function commandPreview(command: string): string {
  return command.length > MAX_COMMAND_LENGTH ? command.slice(0, MAX_COMMAND_LENGTH - 3) + '...' : command;
}

/** A running session: spinner + command + elapsed time. */
const RunningItem = React.memo(function RunningItem({ session }: { session: ShellSession }) {
  return (
    <Box>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text color="cyan"> $ {commandPreview(session.command)}</Text>
      <Text dimColor> ({elapsedSeconds(session)}s)</Text>
    </Box>
  );
});

const UNKNOWN_ICON = { symbol: '?', color: 'gray' } as const;

/** A finished session: status icon + command + exit code, shown briefly. */
const CompletedItem = React.memo(function CompletedItem({ session }: { session: ShellSession }) {
  // Only terminal sessions reach here (selectCompletedBackgroundShells); the
  // fallback keeps the render crash-proof if that invariant ever changes.
  const icon = TERMINAL_ICON[session.status as TerminalShellStatus] ?? UNKNOWN_ICON;
  const outcome = session.exitCode !== null ? `exit ${session.exitCode}` : session.status;
  return (
    <Box>
      <Text color={icon.color}>{icon.symbol} </Text>
      <Text dimColor>
        $ {commandPreview(session.command)} - {outcome} ({elapsedSeconds(session)}s)
      </Text>
    </Box>
  );
});

/**
 * Live indicator for background shell sessions (bash_execute run_in_background /
 * yield_time_ms), shown above the prompt. Running sessions get a spinner; finished
 * sessions linger briefly with their exit code, then auto-clear. Mirrors
 * BackgroundAgentStatus, including the static-summary fallback while a permission
 * prompt is active (spinners re-render constantly and disrupt SelectInput keys).
 */
export function BackgroundShellStatus() {
  const active = useCliStore(useShallow(selectActiveBackgroundShells));
  const completed = useCliStore(useShallow(selectCompletedBackgroundShells));
  const permissionPrompt = useCliStore(state => state.permissionPrompt);
  const cleanupCompleted = useCliStore(state => state.cleanupCompletedBackgroundShells);

  // Auto-clear finished sessions after their display window (keyed on count to
  // avoid re-arming the timer on unrelated re-renders).
  useEffect(() => {
    if (completed.length === 0) return;
    const timer = setTimeout(cleanupCompleted, COMPLETED_DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [completed.length, cleanupCompleted]);

  if (active.length === 0 && completed.length === 0) return null;

  // A permission prompt owns the keyboard - a spinner's re-renders break SelectInput.
  if (permissionPrompt) {
    if (active.length === 0) return null;
    const label = active.length === 1 ? '1 shell running' : `${active.length} shells running`;
    return (
      <Box paddingX={1}>
        <Text dimColor>Background: {label}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {active.map(session => (
        <RunningItem key={session.id} session={session} />
      ))}
      {completed.map(session => (
        <CompletedItem key={session.id} session={session} />
      ))}
    </Box>
  );
}
