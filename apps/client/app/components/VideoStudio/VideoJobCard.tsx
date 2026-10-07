import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, Card, Chip, LinearProgress, Stack, Typography, type ColorPaletteProp } from '@mui/joy';
import { toast } from 'sonner';
import type { GenerationJobState, VideoGeneration } from '@bike4mind/common';
import { useFileBrowser } from '@client/app/components/Files/fileBrowserStore';
import { isTerminalVideoState } from '@client/app/hooks/data/videoGenerationCache';
import { useCancelVideoGeneration, useVideoGeneration } from '@client/app/hooks/data/videoGenerations';
import { downloadData, downloadUrl } from '@client/app/utils/download';

const STATE_LABELS: Record<GenerationJobState, string> = {
  pending: 'Queued',
  running: 'Generating',
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
  failed: 'This video could not be generated.',
  blocked: 'The provider declined to generate this video.',
  cancelled: 'The generation was cancelled.',
};

// The server refuses to cancel a storing job: the provider has already produced, and charged for, the clip.
const CANCELLABLE_STATES: readonly GenerationJobState[] = ['pending', 'running'];

// A refreshed URL that fails again (the file was removed or blocked) must not loop.
export const MAX_PLAYER_URL_REFRESHES = 2;

/**
 * Re-signing (every ~14 minutes) must not restart a clip mid-play: keep the URL the player started with until the
 * element reports an error, then take the newest URL, asking for a fresh one at most MAX_PLAYER_URL_REFRESHES times.
 */
export function useStablePlayerSrc(latestUrl: string | null, refresh: () => void) {
  const [src, setSrc] = useState<string | null>(latestUrl);
  const [awaitingFresh, setAwaitingFresh] = useState(false);
  const refreshes = useRef(0);

  useEffect(() => {
    if (src === null && latestUrl) {
      setSrc(latestUrl);
      return;
    }
    if (awaitingFresh && latestUrl && latestUrl !== src) {
      setSrc(latestUrl);
      setAwaitingFresh(false);
    }
  }, [latestUrl, src, awaitingFresh]);

  const onError = useCallback(() => {
    if (latestUrl && latestUrl !== src) {
      setSrc(latestUrl);
      return;
    }
    if (refreshes.current >= MAX_PLAYER_URL_REFRESHES) return;
    refreshes.current += 1;
    setAwaitingFresh(true);
    refresh();
  }, [latestUrl, src, refresh]);

  const onLoaded = useCallback(() => {
    refreshes.current = 0;
  }, []);

  return { src, onError, onLoaded };
}

const videoFileName = (jobId: string, contentType: string | undefined): string =>
  `video-${jobId}.${contentType === 'video/webm' ? 'webm' : 'mp4'}`;

const VideoJobCard = ({ jobId }: { jobId: string }) => {
  const { data: job, isPending, refetch } = useVideoGeneration(jobId);
  const cancel = useCancelVideoGeneration();
  const openFiles = useFileBrowser(state => state.setOpen);
  const refresh = useCallback(() => void refetch(), [refetch]);
  const readyUrl = job?.state === 'succeeded' && job.output?.availability === 'ready' ? job.output.url : null;
  const player = useStablePlayerSrc(readyUrl, refresh);

  const handleDownload = async (): Promise<void> => {
    // Re-read first: the cached URL may be close to expiry.
    const { data: fresh } = await refetch();
    const url = fresh?.output?.availability === 'ready' ? fresh.output.url : null;
    if (!fresh || !url) {
      toast.error('This video is not available to download.');
      return;
    }
    const fileName = videoFileName(fresh.id, fresh.output?.content_type);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download failed with ${response.status}`);
      downloadData(await response.blob(), fileName, fresh.output?.content_type);
    } catch (error) {
      // A cross-origin read can be refused; the browser can still fetch the signed URL itself.
      console.error('Video download through a blob failed; opening the signed URL instead', error);
      downloadUrl(url, fileName);
    }
  };

  if (isPending) {
    return (
      <Card variant="outlined" data-testid="video-job-card-loading">
        <LinearProgress />
      </Card>
    );
  }
  if (!job) {
    return (
      <Card variant="outlined" data-testid="video-job-card-missing">
        <Typography level="body-sm">This video could not be loaded.</Typography>
      </Card>
    );
  }

  const terminal = isTerminalVideoState(job.state);
  const output: VideoGeneration['output'] = job.state === 'succeeded' ? job.output : null;
  const failureMessage = job.error?.message ?? FAILURE_FALLBACK[job.state];
  const isSettling = job.state === 'succeeded' && (!job.output || job.output.availability === 'pending_scan');
  const statusLabel = (() => {
    if (cancel.isSuccess && !terminal) return 'Cancelling';
    if (isSettling) return job.output ? 'Checking' : 'Finishing';
    return STATE_LABELS[job.state];
  })();
  const statusColor: ColorPaletteProp = isSettling ? 'primary' : STATE_COLORS[job.state];

  return (
    <Card variant="outlined" data-testid="video-job-card" data-job-id={job.id} sx={{ gap: 1 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Chip size="sm" variant="soft" color={statusColor} data-testid="video-job-card-status">
          {statusLabel}
        </Chip>
        <Typography level="body-xs">
          {job.duration_seconds}s, {job.aspect_ratio}, {job.resolution}
        </Typography>
      </Stack>

      <Typography level="body-sm" sx={{ wordBreak: 'break-word' }} data-testid="video-job-card-prompt">
        {job.prompt}
      </Typography>

      {(!terminal || isSettling) && (
        <Stack gap={0.5}>
          <LinearProgress
            data-testid="video-job-card-progress"
            determinate={job.state === 'running' && job.progress !== null}
            value={job.progress !== null ? Math.round(job.progress * 100) : undefined}
          />
          {job.state === 'running' && job.progress !== null && (
            <Typography level="body-xs" data-testid="video-job-card-progress-label">
              {Math.round(job.progress * 100)}%
            </Typography>
          )}
        </Stack>
      )}

      {job.state === 'succeeded' && output?.availability === 'ready' && player.src && (
        <Box
          component="video"
          controls
          preload="metadata"
          src={player.src}
          onError={player.onError}
          onLoadedData={player.onLoaded}
          data-testid="video-job-card-player"
          sx={{ width: '100%', borderRadius: 'sm', backgroundColor: 'common.black' }}
        />
      )}
      {job.state === 'succeeded' && output?.availability === 'pending_scan' && (
        <Typography level="body-sm" data-testid="video-job-card-scan-note">
          Your video is being checked and will play here shortly.
        </Typography>
      )}
      {job.state === 'succeeded' && !job.output && (
        <Typography level="body-sm" data-testid="video-job-card-finishing-note">
          Finishing...
        </Typography>
      )}
      {job.state === 'succeeded' && job.output?.availability === 'unavailable' && (
        <Typography level="body-sm" data-testid="video-job-card-unavailable-note">
          This video is no longer available.
        </Typography>
      )}
      {failureMessage && (
        <Typography level="body-sm" color="danger" data-testid="video-job-card-error">
          {failureMessage}
        </Typography>
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
            data-testid="video-job-card-cancel-btn"
          >
            Cancel
          </Button>
        )}
        {output?.availability === 'ready' && (
          <Button
            size="sm"
            variant="outlined"
            onClick={() => void handleDownload()}
            data-testid="video-job-card-download-btn"
          >
            Download
          </Button>
        )}
        {output?.file_id && output.availability !== 'unavailable' && (
          <Button size="sm" variant="plain" onClick={() => openFiles(true)} data-testid="video-job-card-open-files-btn">
            Open in Files
          </Button>
        )}
      </Stack>
    </Card>
  );
};

export default VideoJobCard;
