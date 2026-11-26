import { useEffect, useState, type ReactNode } from 'react';
import { CircularProgress } from '@mui/joy';
import { styled } from '@mui/system';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import TimelineIcon from '@mui/icons-material/Timeline';
import type { GenerationJobState } from '@bike4mind/common';
import { isFabFileScanInFlight, useGetFabFile } from '@client/app/hooks/data/fabFileQueries';
import type { StudioImageJob } from '@client/app/hooks/data/studioImageJobs';
import StudioTrailDialog from '@client/app/components/Studio/trail/StudioTrailDialog';
import type { StudioTrailRestore } from '@client/app/components/Studio/trail/StudioTrail';
import { CHECKERBOARD_SX } from '@client/app/components/Studio/checkerboard';
import { StudioTakeAction, StudioTakeTile } from '@client/app/components/Studio/design/StudioTakeTile';
import { studioColor, studioFont } from '@client/app/components/Studio/design/studioTokens';

const LIVE_LABELS: Partial<Record<GenerationJobState, string>> = {
  pending: 'Queued',
  running: 'Generating',
  storing: 'Saving',
};

// A cutout's prompt is the server's fixed instruction, so it is named for what it is instead.
const jobCaption = (job: StudioImageJob): string => {
  if (job.purpose !== 'cutout') return job.request.prompt;
  return job.state === 'succeeded' ? 'Background removed' : 'Background removal';
};

/** How long (ms) a card waits on the moderation scan before it stops asking for the image. */
export const IMAGE_SCAN_WAIT_MS = 30 * 1000;

// Fills the take's frame, so a failed take reads as a whole tile in the warm danger tone, not a line of red text.
const FrameMessage = styled('div')({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  width: '100%',
  height: '100%',
  padding: '16px',
  boxSizing: 'border-box',
  textAlign: 'center',
  color: studioColor('text-secondary'),
  font: `400 13px/1.45 ${studioFont('ui')}`,
  '&[data-tone="danger"]': { backgroundColor: studioColor('danger-soft'), color: studioColor('danger') },
});

// A failed job carries the provider's raw error text, which can run past the square frame; the tooltip keeps the rest.
const FrameMessageText = styled('span')({
  display: '-webkit-box',
  WebkitLineClamp: 5,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
});

const PreviewMessage = ({
  testId,
  tone = 'neutral',
  icon,
  children,
}: {
  testId: string;
  tone?: 'neutral' | 'danger';
  icon?: ReactNode;
  children: string;
}) => (
  <FrameMessage data-tone={tone} data-testid={testId}>
    {icon}
    <FrameMessageText title={children}>{children}</FrameMessageText>
  </FrameMessage>
);

const LiveLabel = styled('span')({
  fontFamily: studioFont('mono'),
  fontSize: '11px',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: studioColor('text-muted'),
});

const LiveSpinner = () => (
  <CircularProgress
    size="sm"
    sx={{
      '--CircularProgress-progressColor': studioColor('accent-bright'),
      '--CircularProgress-trackColor': studioColor('border'),
    }}
  />
);

// A cutout is shown whole, on a checkerboard, so its transparent background reads as transparent.
const CutoutFrame = styled('div')({
  ...CHECKERBOARD_SX,
  width: '100%',
  height: '100%',
  '& > img': { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
});

// GET /api/files/:id signs the file once its moderation scan is clean, so the image renders straight from its record.
const ImageJobPreview = ({ fileId, prompt, cutout }: { fileId: string; prompt: string; cutout: boolean }) => {
  const [gaveUp, setGaveUp] = useState(false);
  const file = useGetFabFile(fileId, { pollWhileScanning: !gaveUp });
  const scanning = !!file.data && isFabFileScanInFlight(file.data);

  useEffect(() => {
    if (!scanning) return;
    const timer = setTimeout(() => setGaveUp(true), IMAGE_SCAN_WAIT_MS);
    return () => clearTimeout(timer);
  }, [scanning]);

  if (file.data?.fileUrl) {
    const image = <img src={file.data.fileUrl} alt={prompt} loading="lazy" data-testid="image-job-image" />;
    return cutout ? <CutoutFrame>{image}</CutoutFrame> : image;
  }
  if (file.data?.moderationStatus === 'blocked') {
    return (
      <PreviewMessage testId="image-job-image-blocked">This image was blocked by content moderation.</PreviewMessage>
    );
  }
  if ((!file.data && !file.isError) || (scanning && !gaveUp)) {
    return (
      <span data-testid="image-job-image-loading">
        <LiveSpinner />
      </span>
    );
  }
  return (
    <PreviewMessage testId="image-job-image-unavailable">
      The image could not be loaded. Reload the page to try again.
    </PreviewMessage>
  );
};

// A socket frame marks the row 'succeeded' before the gallery refetch brings its output.
const isAwaitingOutput = (job: StudioImageJob) => job.state === 'succeeded' && job.output === null;

const JobBody = ({ job }: { job: StudioImageJob }) => {
  const liveLabel = isAwaitingOutput(job) ? LIVE_LABELS.storing : LIVE_LABELS[job.state];
  if (liveLabel) {
    return (
      <FrameMessage data-testid="image-job-live">
        <LiveSpinner />
        <LiveLabel>{liveLabel}</LiveLabel>
      </FrameMessage>
    );
  }
  if (job.state === 'succeeded') {
    return job.output?.fileId ? (
      <ImageJobPreview fileId={job.output.fileId} prompt={jobCaption(job)} cutout={job.purpose === 'cutout'} />
    ) : (
      // Final: the worker kept the image outside Files (imageJobHandler's fallback), so there is no file to show.
      <PreviewMessage testId="image-job-unviewable">
        The image was made but could not be added to your Files.
      </PreviewMessage>
    );
  }
  return (
    <PreviewMessage testId="image-job-error" tone="danger" icon={<ErrorOutlineIcon />}>
      {job.error?.message ?? 'The image could not be generated.'}
    </PreviewMessage>
  );
};

type ImageJobCardProps = {
  job: StudioImageJob;
  /** Passed through to the trail, whose steps restore settings only when it is set. */
  onRestore?: StudioTrailRestore;
};

/** One image job in the gallery: live while it renders, the image once saved, the fixed error text if it failed. */
const ImageJobCard = ({ job, onRestore }: ImageJobCardProps) => {
  const [isTrailOpen, setIsTrailOpen] = useState(false);
  const fileId = job.output?.fileId ?? null;
  return (
    <>
      <StudioTakeTile
        testId={`image-job-card-${job.id}`}
        state={job.state}
        media={<JobBody job={job} />}
        title={jobCaption(job)}
        meta={job.request.model}
        actions={
          fileId ? (
            <StudioTakeAction
              label="Show trail"
              icon={<TimelineIcon fontSize="small" />}
              onClick={() => setIsTrailOpen(true)}
              testId={`image-job-trail-btn-${job.id}`}
            />
          ) : undefined
        }
      />
      {fileId && (
        <StudioTrailDialog
          fileId={fileId}
          open={isTrailOpen}
          onClose={() => setIsTrailOpen(false)}
          onRestore={onRestore}
        />
      )}
    </>
  );
};

export default ImageJobCard;
