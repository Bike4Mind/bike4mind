import { useMemo, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Card from '@mui/joy/Card';
import Chip from '@mui/joy/Chip';
import LinearProgress from '@mui/joy/LinearProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ColorPaletteProp } from '@mui/joy/styles';
import type { ChatMessage, ChatVideoJob, ChatVideoJobState } from '@shared/chat';
import { useVideoJobsContext, type VideoJobsController } from './useVideoJobs';

const STATE_LABELS: Record<ChatVideoJobState, string> = {
  pending: 'Queued',
  running: 'Generating',
  storing: 'Saving',
  succeeded: 'Ready',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

const STATE_COLORS: Record<ChatVideoJobState, ColorPaletteProp> = {
  pending: 'neutral',
  running: 'primary',
  storing: 'primary',
  succeeded: 'success',
  failed: 'danger',
  blocked: 'warning',
  cancelled: 'neutral',
};

/** The server refuses to cancel a storing job: the clip already exists and was billed. */
const CANCELLABLE: readonly ChatVideoJobState[] = ['pending', 'running'];

/**
 * Only this app's own media scheme reaches the player. Main never stores anything else on a
 * job, so this is a second lock on the same door, not the first one.
 */
const isLocalMedia = (url: string): boolean => url.startsWith('b4m-media://');

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusOf(job: ChatVideoJob, cancelling: boolean): { label: string; color: ColorPaletteProp } {
  if (job.stalled) return { label: 'Stalled', color: 'warning' };
  if (cancelling && CANCELLABLE.includes(job.state)) return { label: 'Cancelling', color: 'neutral' };
  if (job.state === 'succeeded' && !job.media && !job.error) {
    return { label: job.availability === 'pending_scan' ? 'Checking' : 'Finishing', color: 'primary' };
  }
  return { label: STATE_LABELS[job.state], color: STATE_COLORS[job.state] };
}

export function VideoJobCard({ job, actions }: { job: ChatVideoJob; actions: VideoJobsController }) {
  const [cancelling, setCancelling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [playerFailed, setPlayerFailed] = useState(false);

  const status = statusOf(job, cancelling);
  const inFlight = !job.stalled && !job.error && !job.media && job.availability !== 'unavailable';
  const progress = job.state === 'running' && job.progress !== undefined ? Math.round(job.progress * 100) : null;
  const credits = job.reservedCredits ?? job.estimatedCredits;
  const playable = job.media && isLocalMedia(job.media.url) ? job.media : null;

  const run = async (work: () => Promise<void>) => {
    setNote(null);
    try {
      await work();
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'That did not work.');
    }
  };

  const cancel = () =>
    run(async () => {
      setCancelling(true);
      try {
        await actions.cancel(job.id);
      } finally {
        setCancelling(false);
      }
    });

  const copyLink = () =>
    run(async () => {
      const result = await actions.copyLink(job.id);
      if (!result.ok) {
        setNote(result.message);
        return;
      }
      const until = result.expiresAt ? new Date(result.expiresAt).toLocaleTimeString([], { timeStyle: 'short' }) : null;
      setNote(until ? `Link copied. It works until ${until}.` : 'Link copied.');
    });

  return (
    <Card variant="outlined" size="sm" sx={{ gap: 1, maxWidth: 560 }} data-testid="video-job-card" data-job-id={job.id}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Chip size="sm" variant="soft" color={status.color} data-testid="video-job-card-status">
          {status.label}
        </Chip>
        <Typography level="body-xs" textColor="text.tertiary">
          {job.modelName}, {job.durationSeconds}s, {job.aspectRatio}, {job.resolution}
          {credits ? `, ${credits.toLocaleString('en-US')} credits` : ''}
        </Typography>
      </Stack>

      <Typography
        level="body-sm"
        data-testid="video-job-card-prompt"
        sx={{
          wordBreak: 'break-word',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {job.prompt}
      </Typography>

      {inFlight && (
        <Stack gap={0.5}>
          {/* Only a determinate bar gets `value`: Joy sizes the indeterminate sweep from it. */}
          <LinearProgress
            data-testid="video-job-card-progress"
            determinate={progress !== null}
            {...(progress !== null ? { value: progress } : {})}
          />
          <Typography level="body-xs" textColor="text.tertiary">
            {job.availability === 'pending_scan'
              ? 'Your video is being checked and will play here shortly.'
              : job.state === 'succeeded'
                ? 'Downloading the video...'
                : progress !== null
                  ? `${progress}%`
                  : 'Rendering on the server. You can keep working; this card updates by itself.'}
          </Typography>
        </Stack>
      )}

      {playable &&
        (playerFailed ? (
          <Typography level="body-sm" color="warning" data-testid="video-job-card-player-failed">
            This video could not be loaded. It may have been removed with an earlier version of this conversation.
          </Typography>
        ) : (
          // preload="metadata": a thread of many clips reads only their headers until one is played.
          <Box
            component="video"
            controls
            preload="metadata"
            src={playable.url}
            onError={() => setPlayerFailed(true)}
            data-testid="video-job-card-player"
            sx={{
              width: '100%',
              maxHeight: 420,
              borderRadius: 'sm',
              backgroundColor: 'common.black',
              display: 'block',
            }}
          />
        ))}

      {job.stalled && !job.error && (
        <Typography level="body-sm" color="warning" data-testid="video-job-card-stalled">
          This job has not finished after an hour, so this app stopped checking on it.
        </Typography>
      )}
      {job.error && (
        <Typography level="body-sm" color="danger" data-testid="video-job-card-error">
          {job.error}
        </Typography>
      )}

      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
        {CANCELLABLE.includes(job.state) && !job.stalled && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            loading={cancelling}
            onClick={() => void cancel()}
            data-testid="video-job-card-cancel-btn"
          >
            Cancel
          </Button>
        )}
        {job.stalled && (
          <Button
            size="sm"
            variant="soft"
            onClick={() => void run(() => actions.recheck(job.id))}
            data-testid="video-job-card-recheck-btn"
          >
            Check again
          </Button>
        )}
        {playable && (
          <>
            <Button
              size="sm"
              variant="soft"
              onClick={() => void run(() => actions.open(job.id))}
              data-testid="video-job-card-open-btn"
            >
              Open
            </Button>
            <Button
              size="sm"
              variant="soft"
              onClick={() => void run(async () => void (await actions.save(job.id)))}
              data-testid="video-job-card-save-btn"
            >
              Save...
            </Button>
            <Button
              size="sm"
              variant="plain"
              onClick={() => void copyLink()}
              data-testid="video-job-card-copy-link-btn"
            >
              Copy link
            </Button>
            <Typography level="body-xs" textColor="text.tertiary">
              {formatBytes(playable.byteLength)}
            </Typography>
          </>
        )}
      </Stack>
      {note && (
        <Typography level="body-xs" textColor="text.secondary" data-testid="video-job-card-note">
          {note}
        </Typography>
      )}
    </Card>
  );
}

/** The cards for one generate_video call, under its row. Renders nothing until main reports a job. */
export function VideoJobsForCall({ callId }: { callId: string }) {
  const actions = useVideoJobsContext();
  const jobs = useMemo(() => actions?.jobs.filter(job => job.callId === callId) ?? [], [actions?.jobs, callId]);
  if (!actions || jobs.length === 0) return null;
  return (
    <Stack spacing={1} sx={{ mt: 1 }} data-testid="video-job-list">
      {jobs.map(job => (
        <VideoJobCard key={job.id} job={job} actions={actions} />
      ))}
    </Stack>
  );
}

/**
 * Jobs whose tool row never reached disk - the app quit or crashed mid-turn, after the job was
 * created and before the reply was written. Billed work must stay visible, so they gather here.
 */
export function OrphanVideoJobs({ messages }: { messages: readonly ChatMessage[] }) {
  const actions = useVideoJobsContext();
  const orphans = useMemo(() => {
    if (!actions || actions.jobs.length === 0) return [];
    const callIds = new Set(messages.flatMap(message => message.toolCalls?.map(call => call.id) ?? []));
    return actions.jobs.filter(job => !callIds.has(job.callId));
  }, [actions, messages]);
  if (!actions || orphans.length === 0) return null;
  return (
    <Stack spacing={1} data-testid="video-job-orphans">
      <Typography level="body-xs" textColor="text.tertiary">
        Videos started in a reply that was not saved
      </Typography>
      {orphans.map(job => (
        <VideoJobCard key={job.id} job={job} actions={actions} />
      ))}
    </Stack>
  );
}
