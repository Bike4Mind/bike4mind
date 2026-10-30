import { useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import {
  isSpawnedRunning,
  splitTasks,
  taskElapsedMs,
  taskStatusLabel,
  taskTitle,
  useSecondTick,
  type SpawnedSessionView,
} from './backgroundTasks';
import { DisclosureIcon, StopIcon } from './icons';
import { formatElapsed } from './statusLine';
import type { BackgroundProcessView } from './useBackgroundProcesses';

export interface BackgroundSectionProps {
  processes: readonly BackgroundProcessView[];
  spawned: readonly SpawnedSessionView[];
  onStopProcess: (processId: string) => void;
  onStopSession: (sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  /** Open the full task panel, which carries each command's log tail. */
  onShowOutput: () => void;
}

/** "2 running", or "3 finished" once nothing is: the section header's collapsed summary. */
export function backgroundSummary(
  processes: readonly BackgroundProcessView[],
  spawned: readonly SpawnedSessionView[]
): string {
  const total = processes.length + spawned.length;
  const running = splitTasks(processes).running.length + spawned.filter(isSpawnedRunning).length;
  return running > 0 ? `${running} running` : `${total} finished`;
}

const linkSx = {
  all: 'unset',
  cursor: 'pointer',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  '&:hover': { textDecoration: 'underline' },
  '&:focus-visible': { outline: '2px solid var(--joy-palette-focusVisible)', borderRadius: '2px' },
} as const;

function TaskRow({
  title,
  meta,
  stop,
  testId,
}: {
  title: ReactNode;
  meta: string;
  stop?: { label: string; onStop: () => void };
  testId: string;
}) {
  return (
    <Stack direction="row" alignItems="center" spacing={0.75} sx={{ minHeight: 26, minWidth: 0 }} data-testid={testId}>
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex' }}>{title}</Box>
      <Typography
        level="body-xs"
        textColor="text.tertiary"
        noWrap
        sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
      >
        {meta}
      </Typography>
      {stop && (
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={stop.label}
          onClick={stop.onStop}
          sx={{ '--IconButton-size': '24px' }}
          data-testid="session-panel-task-stop-btn"
        >
          <StopIcon />
        </IconButton>
      )}
    </Stack>
  );
}

function CommandTitle({ command }: { command: string }) {
  return (
    <Typography level="body-xs" noWrap sx={{ fontFamily: 'code', minWidth: 0 }} title={command}>
      {taskTitle(command)}
    </Typography>
  );
}

function SessionTitle({ entry, onOpen }: { entry: SpawnedSessionView; onOpen: (sessionId: string) => void }) {
  return (
    <Typography
      level="body-xs"
      component="button"
      type="button"
      onClick={() => onOpen(entry.id)}
      title={`Open ${entry.title}`}
      sx={linkSx}
      data-testid="session-panel-spawned-open-btn"
    >
      {entry.title}
    </Typography>
  );
}

/**
 * The open conversation's background commands and the sessions it spawned, running first.
 *
 * Finished entries fold under a count, as they do in the task panel; the log tails stay in that
 * panel (Show output), which is wide enough to read them.
 */
export function BackgroundSection({
  processes,
  spawned,
  onStopProcess,
  onStopSession,
  onOpenSession,
  onShowOutput,
}: BackgroundSectionProps) {
  const [finishedOpen, setFinishedOpen] = useState(false);
  const commands = splitTasks(processes);
  const runningSessions = spawned.filter(isSpawnedRunning);
  const finishedSessions = spawned.filter(entry => !isSpawnedRunning(entry));
  const now = useSecondTick(commands.running.length + runningSessions.length > 0);
  const finishedCount = commands.finished.length + finishedSessions.length;

  return (
    <Stack spacing={0.25} sx={{ minWidth: 0 }}>
      {commands.running.map(entry => (
        <TaskRow
          key={entry.id}
          title={<CommandTitle command={entry.command} />}
          meta={formatElapsed(taskElapsedMs(entry, now))}
          stop={{ label: `Stop ${taskTitle(entry.command)}`, onStop: () => onStopProcess(entry.id) }}
          testId="session-panel-task-running"
        />
      ))}
      {runningSessions.map(entry => (
        <TaskRow
          key={entry.id}
          title={<SessionTitle entry={entry} onOpen={onOpenSession} />}
          meta={`${entry.status === 'needs-action' ? 'needs you \u00b7 ' : ''}${formatElapsed(
            taskElapsedMs({ startedAt: entry.createdAt }, now)
          )}`}
          stop={{ label: `Stop ${entry.title}`, onStop: () => onStopSession(entry.id) }}
          testId="session-panel-spawned-running"
        />
      ))}

      {finishedCount > 0 && (
        <>
          <Box
            component="button"
            type="button"
            aria-expanded={finishedOpen}
            onClick={() => setFinishedOpen(current => !current)}
            sx={{
              ...linkSx,
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              py: 0.25,
              color: 'text.tertiary',
              '&:hover': { color: 'text.secondary' },
            }}
            data-testid="session-panel-finished-toggle-btn"
          >
            <Typography level="body-xs" textColor="inherit" fontWeight="lg">
              {`Finished ${finishedCount}`}
            </Typography>
            <DisclosureIcon open={finishedOpen} />
          </Box>
          {finishedOpen &&
            commands.finished.map(entry => (
              <TaskRow
                key={entry.id}
                title={<CommandTitle command={entry.command} />}
                meta={taskStatusLabel(entry)}
                testId="session-panel-task-finished"
              />
            ))}
          {finishedOpen &&
            finishedSessions.map(entry => (
              <TaskRow
                key={entry.id}
                title={<SessionTitle entry={entry} onOpen={onOpenSession} />}
                meta="session"
                testId="session-panel-spawned-finished"
              />
            ))}
        </>
      )}

      {processes.length > 0 && (
        <Box>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={onShowOutput}
            sx={{ minHeight: 24, px: 0.75, ml: -0.75, fontSize: 'xs', fontWeight: 'md' }}
            data-testid="session-panel-show-output-btn"
          >
            Show output
          </Button>
        </Box>
      )}
    </Stack>
  );
}
