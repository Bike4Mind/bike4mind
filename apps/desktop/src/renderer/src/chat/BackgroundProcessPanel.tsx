import { useEffect, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { BackgroundProcessStatus } from '@shared/chat';
import { contentColumnSx } from './layout';
import type { BackgroundProcessView } from './useBackgroundProcesses';

const STATUS_COLOR: Record<BackgroundProcessStatus, 'success' | 'neutral' | 'warning' | 'danger'> = {
  running: 'success',
  exited: 'neutral',
  killed: 'warning',
  failed: 'danger',
};

function statusLabel(entry: BackgroundProcessView): string {
  if (entry.status === 'running') return 'running';
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
      sx={{ mt: 0.75, maxHeight: 180, overflowY: 'auto', bgcolor: 'background.level1', borderRadius: 'sm', p: 1 }}
    >
      <Typography
        level="body-xs"
        fontFamily="monospace"
        textColor="text.secondary"
        sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        data-testid="background-process-output"
      >
        {text || 'No output yet.'}
      </Typography>
    </Box>
  );
}

function ProcessRow({ entry, onStop }: { entry: BackgroundProcessView; onStop: (id: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <Box sx={{ borderRadius: 'sm', bgcolor: 'background.level2', px: 1, py: 0.75 }} data-testid="background-process">
      <Stack direction="row" spacing={1} alignItems="center">
        <Chip size="sm" variant="soft" color={STATUS_COLOR[entry.status]} data-testid="background-process-status">
          {statusLabel(entry)}
        </Chip>
        <Typography
          level="body-xs"
          fontFamily="monospace"
          noWrap
          sx={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
          onClick={() => setOpen(current => !current)}
        >
          {entry.command}
        </Typography>
        <Button size="sm" variant="plain" color="neutral" onClick={() => setOpen(current => !current)}>
          {open ? 'Hide' : 'Output'}
        </Button>
        {entry.status === 'running' && (
          <Button
            size="sm"
            variant="soft"
            color="danger"
            onClick={() => onStop(entry.id)}
            data-testid="background-process-stop"
          >
            Stop
          </Button>
        )}
      </Stack>

      {open && <OutputTail text={entry.output} />}
    </Box>
  );
}

/**
 * The background processes this conversation has running, above the composer.
 *
 * Deliberately not folded into the tool call that started one: a dev server outlives the turn
 * that started it, and a handle buried in scrollback is a process the user has lost track of.
 * Having it permanently on screen with a Stop button next to it is the point - the failure
 * this feature has to avoid is a forgotten process still holding a port.
 */
export function BackgroundProcessPanel({
  processes,
  onStop,
}: {
  processes: BackgroundProcessView[];
  onStop: (processId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (processes.length === 0) return null;

  const running = processes.filter(entry => entry.status === 'running').length;

  return (
    <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }} data-testid="background-process-panel">
      <Box sx={{ ...contentColumnSx, py: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ cursor: 'pointer' }}>
          <Typography
            level="body-xs"
            fontWeight="lg"
            textColor="text.tertiary"
            onClick={() => setCollapsed(current => !current)}
            sx={{ flex: 1 }}
          >
            {running > 0 ? `${running} running in the background` : 'Background commands'}
          </Typography>
          <Button size="sm" variant="plain" color="neutral" onClick={() => setCollapsed(current => !current)}>
            {collapsed ? 'Show' : 'Hide'}
          </Button>
        </Stack>

        {!collapsed && (
          <Stack spacing={0.5} sx={{ mt: 0.75 }}>
            {processes.map(entry => (
              <ProcessRow key={entry.id} entry={entry} onStop={onStop} />
            ))}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
