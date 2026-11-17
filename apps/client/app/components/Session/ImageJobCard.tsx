import { useCallback } from 'react';
import {
  AspectRatio,
  Box,
  Card,
  Chip,
  CircularProgress,
  Link,
  Stack,
  Typography,
  type ColorPaletteProp,
} from '@mui/joy';
import type { GenerationJobState } from '@bike4mind/common';
import { STATE_COLORS, useStablePlayerSrc } from '@client/app/hooks/data/generationJobCard';
import { isTerminalGenerationState } from '@client/app/hooks/data/generationJobPolling';
import { useImageJob, type ChatImageJob } from '@client/app/hooks/data/imageJobs';

const STATE_LABELS: Record<GenerationJobState, string> = {
  pending: 'Queued',
  running: 'Generating',
  storing: 'Saving',
  succeeded: 'Ready',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

// Used only if a terminal job somehow has no public error; the server normally sends a code-derived message.
const FAILURE_FALLBACK: Partial<Record<GenerationJobState, string>> = {
  failed: 'This image could not be generated.',
  blocked: 'The provider declined to generate this image.',
  cancelled: 'The generation was cancelled.',
};

/** The chip names what the body shows: a succeeded job is "Ready" only once its image can be shown. */
const chipFor = (job: ChatImageJob): { label: string; color: ColorPaletteProp } => {
  if (job.state !== 'succeeded' || job.output?.availability === 'ready') {
    return { label: STATE_LABELS[job.state], color: STATE_COLORS[job.state] };
  }
  if (job.output?.availability === 'unavailable') return { label: 'Unavailable', color: 'neutral' };
  return { label: job.output ? 'Checking' : 'Finishing', color: 'primary' };
};

const ImageResult = ({
  job,
  src,
  onError,
  onLoaded,
}: {
  job: ChatImageJob;
  src: string;
  onError: () => void;
  onLoaded: () => void;
}) => (
  <Link
    href={src}
    target="_blank"
    rel="noopener noreferrer"
    aria-label="Open image full size"
    sx={{ display: 'block', width: '100%', height: '100%' }}
  >
    {/* Sized here: AspectRatio only fits an img that is a direct child of its first child, and this one is inside the link. */}
    <img
      src={src}
      alt={job.prompt}
      loading="lazy"
      onError={onError}
      onLoad={onLoaded}
      style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
      data-testid="image-job-card-image"
    />
  </Link>
);

type Player = ReturnType<typeof useStablePlayerSrc>;

const JobBody = ({ job, player }: { job: ChatImageJob; player: Player }) => {
  if (job.state === 'succeeded' && job.output?.availability === 'ready' && player.src) {
    return <ImageResult job={job} src={player.src} onError={player.onError} onLoaded={player.onLoaded} />;
  }
  if (job.state === 'succeeded' && job.output?.availability === 'unavailable') {
    return (
      <Typography level="body-sm" textAlign="center" sx={{ px: 2 }} data-testid="image-job-card-unavailable-note">
        This image is no longer available.
      </Typography>
    );
  }
  if (!isTerminalGenerationState(job.state) || job.state === 'succeeded') {
    return (
      <Stack alignItems="center" gap={1} data-testid="image-job-card-progress">
        <CircularProgress size="sm" />
        <Typography level="body-sm">{chipFor(job).label}</Typography>
      </Stack>
    );
  }
  return (
    <Typography level="body-sm" color="danger" textAlign="center" sx={{ px: 2 }} data-testid="image-job-card-error">
      {job.error?.message ?? FAILURE_FALLBACK[job.state]}
    </Typography>
  );
};

/** One image a chat tool call asked for: progress while it renders, the image once saved, the public error if it failed. */
const ImageJobCard = ({ jobId }: { jobId: string }) => {
  const { data: job, isPending, refetch } = useImageJob(jobId);
  const refresh = useCallback(() => void refetch(), [refetch]);
  // Kept across re-signs so a fresh URL does not reload a shown image; the newest one is taken only after an error.
  const readyUrl = job?.state === 'succeeded' && job.output?.availability === 'ready' ? job.output.url : null;
  const player = useStablePlayerSrc(readyUrl, refresh);

  if (isPending) {
    return (
      <Card variant="outlined" data-testid="image-job-card-loading">
        <AspectRatio ratio="1" variant="soft">
          <CircularProgress size="sm" />
        </AspectRatio>
      </Card>
    );
  }
  if (!job) {
    return (
      <Card variant="outlined" data-testid="image-job-card-missing">
        <Typography level="body-sm">This image could not be loaded.</Typography>
      </Card>
    );
  }

  const chip = chipFor(job);
  return (
    <Card variant="outlined" data-testid="image-job-card" data-job-id={job.id} data-state={job.state} sx={{ gap: 1 }}>
      <AspectRatio ratio="1" objectFit="contain" variant="soft">
        <Box>
          <JobBody job={job} player={player} />
        </Box>
      </AspectRatio>
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Chip size="sm" variant="soft" color={chip.color} data-testid="image-job-card-state">
          {chip.label}
        </Chip>
        <Chip size="sm" variant="outlined">
          {job.model}
        </Chip>
      </Stack>
    </Card>
  );
};

export default ImageJobCard;
