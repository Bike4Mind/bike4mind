import { useCallback, useState } from 'react';
import { Box, Button, Card, Chip, LinearProgress, Stack, Typography, type ColorPaletteProp } from '@mui/joy';
import type { GenerationJobState, MusicGeneration } from '@bike4mind/common';
import { useFileBrowser } from '@client/app/components/Files/fileBrowserStore';
import { useStablePlayerSrc } from '@client/app/components/VideoStudio/VideoJobCard';
import { isTerminalGenerationState } from '@client/app/hooks/data/generationJobPolling';
import { useCancelMusicGeneration, useMusicGeneration } from '@client/app/hooks/data/musicGenerations';

const STATE_LABELS: Record<GenerationJobState, string> = {
  pending: 'Queued',
  running: 'Composing',
  storing: 'Saving',
  succeeded: 'Ready',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

const STATE_COLORS: Record<GenerationJobState, ColorPaletteProp> = {
  pending: 'neutral',
  running: 'primary',
  storing: 'primary',
  succeeded: 'success',
  failed: 'danger',
  blocked: 'warning',
  cancelled: 'neutral',
};

// Used only if a terminal job somehow has no public error; the server normally sends a code-derived message.
const FAILURE_FALLBACK: Partial<Record<GenerationJobState, string>> = {
  failed: 'This song could not be generated.',
  blocked: 'The provider declined to generate this song.',
  cancelled: 'The generation was cancelled.',
};

// The server refuses to cancel a storing job: the provider has already produced, and charged for, the song.
const CANCELLABLE_STATES: readonly GenerationJobState[] = ['pending', 'running'];

const MusicJobCard = ({ jobId }: { jobId: string }) => {
  const { data: job, isPending, refetch } = useMusicGeneration(jobId);
  const cancel = useCancelMusicGeneration();
  const openFiles = useFileBrowser(state => state.setOpen);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const refresh = useCallback(() => void refetch(), [refetch]);
  const readyUrl = job?.state === 'succeeded' && job.output?.availability === 'ready' ? job.output.url : null;
  const player = useStablePlayerSrc(readyUrl, refresh);

  if (isPending) {
    return (
      <Card variant="outlined" data-testid="music-job-card-loading">
        <LinearProgress />
      </Card>
    );
  }
  if (!job) {
    return (
      <Card variant="outlined" data-testid="music-job-card-missing">
        <Typography level="body-sm">This song could not be loaded.</Typography>
      </Card>
    );
  }

  const terminal = isTerminalGenerationState(job.state);
  const output: MusicGeneration['output'] = job.state === 'succeeded' ? job.output : null;
  const failureMessage = job.error?.message ?? FAILURE_FALLBACK[job.state];
  const isSettling = job.state === 'succeeded' && (!job.output || job.output.availability === 'pending_scan');
  const lyrics = output?.lyrics ?? job.lyrics;
  const statusLabel = (() => {
    if (cancel.isSuccess && !terminal) return 'Cancelling';
    if (isSettling) return job.output ? 'Checking' : 'Finishing';
    return STATE_LABELS[job.state];
  })();
  const statusColor: ColorPaletteProp = isSettling ? 'primary' : STATE_COLORS[job.state];

  return (
    <Card variant="outlined" data-testid="music-job-card" data-job-id={job.id} sx={{ gap: 1 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Chip size="sm" variant="soft" color={statusColor} data-testid="music-job-card-status">
          {statusLabel}
        </Chip>
        <Typography level="body-xs">
          {output?.duration_seconds ?? job.duration_seconds}s{job.instrumental ? ', Instrumental' : ''}
        </Typography>
      </Stack>

      <Typography level="body-sm" sx={{ wordBreak: 'break-word' }} data-testid="music-job-card-prompt">
        {job.prompt}
      </Typography>

      {(!terminal || isSettling) && <LinearProgress data-testid="music-job-card-progress" />}

      {job.state === 'succeeded' && output?.availability === 'ready' && player.src && (
        <Box
          component="audio"
          controls
          preload="metadata"
          src={player.src}
          onError={player.onError}
          onLoadedData={player.onLoaded}
          data-testid="music-job-card-player"
          sx={{ width: '100%' }}
        />
      )}
      {job.state === 'succeeded' && output?.availability === 'pending_scan' && (
        <Typography level="body-sm" data-testid="music-job-card-scan-note">
          Your song is being checked and will play here shortly.
        </Typography>
      )}
      {job.state === 'succeeded' && !job.output && (
        <Typography level="body-sm" data-testid="music-job-card-finishing-note">
          Finishing...
        </Typography>
      )}
      {job.state === 'succeeded' && job.output?.availability === 'unavailable' && (
        <Typography level="body-sm" data-testid="music-job-card-unavailable-note">
          This song is no longer available.
        </Typography>
      )}
      {failureMessage && (
        <Typography level="body-sm" color="danger" data-testid="music-job-card-error">
          {failureMessage}
        </Typography>
      )}

      {lyrics && (
        <Stack gap={0.5} alignItems="flex-start">
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setLyricsOpen(open => !open)}
            aria-expanded={lyricsOpen}
            data-testid="music-job-card-lyrics-toggle"
          >
            {lyricsOpen ? 'Hide lyrics' : 'Show lyrics'}
          </Button>
          {lyricsOpen && (
            <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }} data-testid="music-job-card-lyrics">
              {lyrics}
            </Typography>
          )}
        </Stack>
      )}

      <Stack direction="row" gap={1} flexWrap="wrap">
        {CANCELLABLE_STATES.includes(job.state) && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            loading={cancel.isPending}
            disabled={cancel.isSuccess}
            onClick={() => cancel.mutate(job.id)}
            data-testid="music-job-card-cancel-btn"
          >
            Cancel
          </Button>
        )}
        {output?.file_id && output.availability !== 'unavailable' && (
          <Button size="sm" variant="plain" onClick={() => openFiles(true)} data-testid="music-job-card-open-files-btn">
            Open in Files
          </Button>
        )}
      </Stack>
    </Card>
  );
};

export default MusicJobCard;
