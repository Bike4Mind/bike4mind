import { useEffect, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { runningTasksLabel, splitTasks, taskElapsedMs, taskTitle } from './backgroundTasks';
import { ChevronIcon, CloseIcon, ExpandIcon, StopIcon, TrashIcon } from './icons';
import { contentColumnSx } from './layout';
import { formatElapsed } from './statusLine';
import type { BackgroundProcessView } from './useBackgroundProcesses';

/**
 * The panel's two sizes.
 *
 * Both are a real bite out of the conversation - it is the app's first third column - so the
 * panel is closed until asked for, and the wide size exists for reading a log tail rather than
 * as somewhere to leave it.
 */
export const TASK_PANEL_WIDTH = 300;
export const TASK_PANEL_WIDE_WIDTH = 480;

/**
 * A clock for the elapsed column, and nothing else.
 *
 * Deliberately scoped to this component: the same per-second `setState` hung off the shell
 * would re-render the whole transcript once a second, and a very long thread is exactly the
 * case that has to stay cheap. It also idles when nothing is running, so a panel left open on
 * a list of finished tasks costs nothing at all - and the panel only mounts while it is open,
 * so a closed panel has no timer to idle.
 */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}

function statusLabel(entry: BackgroundProcessView): string {
  if (entry.status === 'killed') return 'stopped';
  if (entry.status === 'failed') return 'failed';
  if (entry.exitCode !== null && entry.exitCode !== undefined) return `exit ${entry.exitCode}`;
  return entry.signal ?? 'exited';
}

/** A log pane that follows the tail, unless the user has scrolled up to read something. */
function OutputTail({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const node = ref.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [text]);

  return (
    <Box
      ref={ref}
      onScroll={event => {
        const node = event.currentTarget;
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}
      sx={{ mt: 0.75, maxHeight: 220, overflowY: 'auto', bgcolor: 'background.surface', borderRadius: 'sm', p: 1 }}
    >
      <Typography
        level="body-xs"
        fontFamily="monospace"
        textColor="text.secondary"
        sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        data-testid="background-task-output"
      >
        {text || 'No output yet.'}
      </Typography>
    </Box>
  );
}

/**
 * One task.
 *
 * The whole card body is the toggle for its output, which is the only reason to open one; the
 * Stop button is a sibling of that toggle rather than inside it, so stopping a task never also
 * expands it.
 */
function TaskCard({
  entry,
  now,
  onStop,
}: {
  entry: BackgroundProcessView;
  now: number;
  onStop: (processId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const running = entry.status === 'running';
  const fields = [running ? 'Bash' : statusLabel(entry), formatElapsed(taskElapsedMs(entry, now))];

  return (
    <Box
      sx={{ borderRadius: 'sm', bgcolor: 'background.level2', px: 1, py: 0.75 }}
      data-testid="background-task"
      data-status={entry.status}
    >
      <Stack direction="row" spacing={0.5} alignItems="flex-start">
        <Box
          onClick={() => setOpen(current => !current)}
          sx={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
          data-testid="background-task-toggle"
        >
          <Typography level="body-sm" noWrap data-testid="background-task-title">
            {taskTitle(entry.command)}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="background-task-meta">
            {fields.join(' \u00b7 ')}
          </Typography>
        </Box>
        {running && (
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label={`Stop ${taskTitle(entry.command)}`}
            onClick={() => onStop(entry.id)}
            data-testid="background-task-stop"
          >
            <StopIcon />
          </IconButton>
        )}
      </Stack>

      {open && <OutputTail text={entry.output} />}
    </Box>
  );
}

/**
 * This conversation's background commands, as a column of their own.
 *
 * They used to sit inline above the composer, which put a dev server's log tail in the middle
 * of the reading column and pushed the transcript up every time one started. A command that
 * outlives the turn that started it is not part of the conversation; it is a thing the window
 * is doing, and it belongs in window chrome where it can be watched or dismissed without
 * moving anything the user is reading.
 *
 * Scope is per conversation, as `BackgroundProcessesController` is: a process belongs to the
 * session that started it, and a list spanning sessions would offer a Stop button for a
 * process the open conversation knows nothing about.
 */
export function BackgroundTaskPanel({
  processes,
  wide,
  onToggleWide,
  onClose,
  onStop,
  onClearFinished,
}: {
  processes: BackgroundProcessView[];
  wide: boolean;
  onToggleWide: () => void;
  onClose: () => void;
  onStop: (processId: string) => void;
  onClearFinished: () => void;
}) {
  const [finishedOpen, setFinishedOpen] = useState(false);
  const { running, finished } = splitTasks(processes);
  const now = useSecondTick(running.length > 0);

  return (
    <Stack
      sx={{
        width: wide ? TASK_PANEL_WIDE_WIDTH : TASK_PANEL_WIDTH,
        flexShrink: 0,
        borderLeft: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        height: '100%',
      }}
      data-testid="background-task-panel"
    >
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ px: 1.5, pt: 1.5, pb: 1 }}>
        <Typography level="title-sm" sx={{ flex: 1, minWidth: 0 }} noWrap>
          Background tasks
        </Typography>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={wide ? 'Narrow background tasks' : 'Widen background tasks'}
          onClick={onToggleWide}
          data-testid="background-task-expand-btn"
        >
          <ExpandIcon expanded={wide} />
        </IconButton>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Hide background tasks"
          onClick={onClose}
          data-testid="background-task-close-btn"
        >
          <CloseIcon />
        </IconButton>
      </Stack>

      <Box sx={{ flex: 1, overflowY: 'auto', px: 1, pb: 1.5 }}>
        {running.length > 0 && (
          <>
            <Typography level="body-xs" fontWeight="lg" textColor="text.tertiary" sx={{ px: 0.5, py: 0.75 }}>
              Running
            </Typography>
            <Stack spacing={0.5}>
              {running.map(entry => (
                <TaskCard key={entry.id} entry={entry} now={now} onStop={onStop} />
              ))}
            </Stack>
          </>
        )}

        {finished.length > 0 && (
          <>
            {/* Collapsed by default, and the trash lives HERE rather than on a card: the one
                control that discards tasks is only ever reachable from the section that has
                none running in it. */}
            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: running.length > 0 ? 1.5 : 0 }}>
              <Stack
                direction="row"
                alignItems="center"
                spacing={0.75}
                onClick={() => setFinishedOpen(current => !current)}
                sx={{ flex: 1, minWidth: 0, cursor: 'pointer', px: 0.5, py: 0.75 }}
                data-testid="background-task-finished-toggle"
              >
                <Typography level="body-xs" fontWeight="lg" textColor="text.tertiary">
                  Finished {finished.length}
                </Typography>
                <Box sx={{ display: 'flex', color: 'text.tertiary' }}>
                  <ChevronIcon open={finishedOpen} />
                </Box>
              </Stack>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label="Clear finished tasks"
                onClick={onClearFinished}
                data-testid="background-task-clear-btn"
              >
                <TrashIcon />
              </IconButton>
            </Stack>

            {finishedOpen && (
              <Stack spacing={0.5}>
                {finished.map(entry => (
                  <TaskCard key={entry.id} entry={entry} now={now} onStop={onStop} />
                ))}
              </Stack>
            )}
          </>
        )}
      </Box>
    </Stack>
  );
}

/**
 * The count above the composer, and the way back to a panel that has been closed.
 *
 * Drawn only while something is running: a chip reading "0 running tasks" is a line of chrome
 * that is never true of anything the user cares about. Finished tasks stay reachable from the
 * panel, which is where they were left.
 */
export function BackgroundTaskChip({ running, onClick }: { running: number; onClick: () => void }) {
  if (running === 0) return null;

  return (
    <Box sx={{ ...contentColumnSx, pt: 1 }}>
      <Chip
        size="sm"
        variant="soft"
        color="neutral"
        onClick={onClick}
        startDecorator={
          // The variation selector forces the text form: bare U+2733 renders as a colour emoji
          // on macOS, which is the one loud thing in a row meant to be glanced at.
          <Typography level="body-xs" textColor="text.tertiary" aria-hidden sx={{ lineHeight: 1 }}>
            {'\u2733\ufe0e'}
          </Typography>
        }
        data-testid="background-task-chip"
      >
        {runningTasksLabel(running)}
      </Chip>
    </Box>
  );
}
