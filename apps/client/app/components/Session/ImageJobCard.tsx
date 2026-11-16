import { AspectRatio, Box, Card, Chip, CircularProgress, IconButton, Link, Stack, Typography } from '@mui/joy';
import DownloadIcon from '@mui/icons-material/Download';
import type { GenerationJobState } from '@bike4mind/common';
import { useGetFabFile } from '@client/app/hooks/data/fabFileQueries';
import { STATE_COLORS } from '@client/app/hooks/data/generationJobCard';
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

type ImageOutput = NonNullable<ChatImageJob['output']>;

// Saved images are re-signed through their file record, so a bare url that expired or never arrived still renders.
const useImageSrc = (output: ImageOutput | null): string | null => {
  const needsFile = !!output && !output.url && !!output.file_id;
  const file = useGetFabFile(needsFile ? output.file_id : null);
  return output?.url ?? file.data?.fileUrl ?? null;
};

const ImageResult = ({ job, output }: { job: ChatImageJob; output: ImageOutput }) => {
  const src = useImageSrc(output);
  if (!src) return <CircularProgress size="sm" data-testid="image-job-card-image-loading" />;
  return (
    <>
      <Link
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open image full size"
        sx={{ display: 'contents' }}
      >
        <img src={src} alt={job.prompt} loading="lazy" data-testid="image-job-card-image" />
      </Link>
      <IconButton
        component="a"
        href={src}
        download={`image-${job.id}`}
        size="sm"
        variant="soft"
        aria-label="Download image"
        data-testid="image-job-card-download-btn"
        sx={{ position: 'absolute', right: 8, bottom: 8 }}
      >
        <DownloadIcon />
      </IconButton>
    </>
  );
};

const JobBody = ({ job }: { job: ChatImageJob }) => {
  if (job.state === 'succeeded' && job.output?.availability === 'ready') {
    return <ImageResult job={job} output={job.output} />;
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
        <Typography level="body-sm">{job.state === 'succeeded' ? 'Finishing' : STATE_LABELS[job.state]}</Typography>
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
  const { data: job, isPending } = useImageJob(jobId);

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

  return (
    <Card variant="outlined" data-testid="image-job-card" data-job-id={job.id} data-state={job.state} sx={{ gap: 1 }}>
      <AspectRatio ratio="1" objectFit="contain" variant="soft" sx={{ position: 'relative' }}>
        <Box>
          <JobBody job={job} />
        </Box>
      </AspectRatio>
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Chip size="sm" variant="soft" color={STATE_COLORS[job.state]} data-testid="image-job-card-state">
          {STATE_LABELS[job.state]}
        </Chip>
        <Chip size="sm" variant="outlined">
          {job.model}
        </Chip>
      </Stack>
    </Card>
  );
};

export default ImageJobCard;
