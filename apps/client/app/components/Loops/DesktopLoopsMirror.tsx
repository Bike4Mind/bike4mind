import { useState } from 'react';
import { Box, Chip, Sheet, Stack, Typography } from '@mui/joy';
import { useDesktopLoopMirror, type IDesktopLoopMirror } from '@client/app/hooks/data/loops';

/** Past this the Desktop is offline or asleep; its loops are stale, never shown as dead (ms). */
const STALE_MS = 5 * 60_000;

function ago(at: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function MirrorRow({ mirror, now }: { mirror: IDesktopLoopMirror; now: number }) {
  const [open, setOpen] = useState(false);
  const { snapshot: loop, localLoopId } = mirror;
  const stale = now - Date.parse(mirror.lastSeenAt) > STALE_MS;
  // A Desktop that stopped posting may have been busy; say what was last known and how old it is.
  const idle = loop.idleReason ?? (loop.lanesBusy > 0 ? undefined : 'idle');
  return (
    <Sheet
      variant="outlined"
      sx={{ p: 1.5, borderRadius: 'sm', cursor: 'pointer' }}
      onClick={() => setOpen(!open)}
      data-testid={`loops-desktop-row-${localLoopId}`}
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography level="title-sm">{loop.name}</Typography>
        <Chip
          size="sm"
          variant="soft"
          color={loop.status === 'error' ? 'danger' : loop.status === 'live' ? 'success' : 'neutral'}
        >
          {loop.status}
        </Chip>
        {idle && (
          <Typography level="body-sm" data-testid="loops-desktop-idle-reason">
            {idle}
          </Typography>
        )}
        {loop.needsYou > 0 && (
          <Chip size="sm" variant="outlined" color="warning">
            {loop.needsYou} need{loop.needsYou === 1 ? 's' : ''} you
          </Chip>
        )}
      </Stack>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }} data-testid="loops-desktop-last-seen">
        {loop.lanesBusy}/{loop.lanes} lanes - {Math.round(loop.spentToday)}
        {loop.budget !== undefined ? `/${loop.budget}` : ''} credits today - last seen {ago(mirror.lastSeenAt, now)}
        {stale ? ' - Desktop offline or asleep' : ''}
      </Typography>
      {open && (
        <Stack spacing={1} sx={{ mt: 1 }} data-testid={`loops-desktop-tickets-${localLoopId}`}>
          {loop.stages.map(stage => {
            const tickets = loop.tickets.filter(ticket => ticket.stage === stage && ticket.status !== 'closed');
            return (
              <Box key={stage}>
                <Typography level="body-xs" fontWeight="lg">
                  {stage} ({tickets.length})
                </Typography>
                {tickets.map((ticket, index) => (
                  <Typography key={index} level="body-xs">
                    {ticket.priority ? `${ticket.priority} ` : ''}
                    {ticket.title}
                    {ticket.status === 'blocked' ? ` - blocked${ticket.reason ? `: ${ticket.reason}` : ''}` : ''}
                    {ticket.status === 'in_progress' ? ' - running' : ''}
                  </Typography>
                ))}
              </Box>
            );
          })}
        </Stack>
      )}
    </Sheet>
  );
}

/**
 * Loops that live on the caller's Desktop, read-only: the Desktop runs them and posts a scrubbed status
 * (pages/api/loops/mirror). Change them in the Desktop app; nothing here acts on them.
 */
export default function DesktopLoopsMirror() {
  // Ages as of the last fetch (every minute), so render stays pure.
  const { data: loops, dataUpdatedAt: now } = useDesktopLoopMirror();
  if (!loops?.length) return null;
  return (
    <Box sx={{ mt: 3 }} data-testid="loops-desktop-mirror">
      <Typography level="title-md">On your Desktop</Typography>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 1 }}>
        Run by Bike4Mind Desktop. Read-only here; open the Desktop app to change them.
      </Typography>
      <Stack spacing={1}>
        {loops.map(mirror => (
          <MirrorRow key={mirror.localLoopId} mirror={mirror} now={now} />
        ))}
      </Stack>
    </Box>
  );
}
