import { useState } from 'react';
import { AspectRatio, Card, CardContent, Chip, CircularProgress, IconButton, Stack, Typography } from '@mui/joy';
import TimelineIcon from '@mui/icons-material/Timeline';
import type { GenerationJobState } from '@bike4mind/common';
import { useGetFabFile } from '@client/app/hooks/data/fabFileQueries';
import type { StudioImageJob } from '@client/app/hooks/data/studioImageJobs';
import StudioTrailDialog from '@client/app/components/Studio/trail/StudioTrailDialog';
import type { StudioTrailRestore } from '@client/app/components/Studio/trail/StudioTrail';
import { CHECKERBOARD_SX } from '@client/app/components/Studio/checkerboard';

const LIVE_LABELS: Partial<Record<GenerationJobState, string>> = {
  pending: 'Queued',
  running: 'Generating',
  storing: 'Saving',
};

// GET /api/files/:id signs the file, so the saved image renders straight from its record.
// A cutout's prompt is the server's fixed instruction, so it is named for what it is instead.
const jobCaption = (job: StudioImageJob): string => {
  if (job.purpose !== 'cutout') return job.request.prompt;
  return job.state === 'succeeded' ? 'Background removed' : 'Background removal';
};

const ImageJobPreview = ({ fileId, prompt }: { fileId: string; prompt: string }) => {
  const file = useGetFabFile(fileId);
  if (!file.data?.fileUrl) return <CircularProgress size="sm" data-testid="image-job-image-loading" />;
  return <img src={file.data.fileUrl} alt={prompt} loading="lazy" data-testid="image-job-image" />;
};

// A socket frame marks the row 'succeeded' before the gallery refetch brings its output.
const isAwaitingOutput = (job: StudioImageJob) => job.state === 'succeeded' && job.output === null;

const JobBody = ({ job }: { job: StudioImageJob }) => {
  const liveLabel = isAwaitingOutput(job) ? LIVE_LABELS.storing : LIVE_LABELS[job.state];
  if (liveLabel) {
    return (
      <Stack alignItems="center" gap={1} data-testid="image-job-live">
        <CircularProgress size="sm" />
        <Typography level="body-sm">{liveLabel}</Typography>
      </Stack>
    );
  }
  if (job.state === 'succeeded') {
    return job.output?.fileId ? (
      <ImageJobPreview fileId={job.output.fileId} prompt={jobCaption(job)} />
    ) : (
      // Final: the worker kept the image outside Files (imageJobHandler's fallback), so there is no file to show.
      <Typography level="body-sm" textAlign="center" sx={{ px: 2 }} data-testid="image-job-unviewable">
        The image was made but could not be added to your Files.
      </Typography>
    );
  }
  return (
    <Typography level="body-sm" color="danger" textAlign="center" sx={{ px: 2 }} data-testid="image-job-error">
      {job.error?.message ?? 'The image could not be generated.'}
    </Typography>
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
  const deliveredCutout = job.purpose === 'cutout' && job.state === 'succeeded';
  return (
    <Card variant="outlined" data-testid={`image-job-card-${job.id}`} data-state={job.state}>
      {/* A cutout is shown whole, on a checkerboard, so its transparent background reads as transparent. */}
      <AspectRatio
        ratio="1"
        objectFit={deliveredCutout ? 'contain' : 'cover'}
        variant="soft"
        sx={deliveredCutout ? { '& > div': CHECKERBOARD_SX } : undefined}
      >
        <JobBody job={job} />
      </AspectRatio>
      <CardContent>
        <Typography
          level="body-sm"
          sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        >
          {jobCaption(job)}
        </Typography>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mt: 0.5 }}>
          <Chip size="sm" variant="soft">
            {job.request.model}
          </Chip>
          {fileId && (
            <IconButton
              size="sm"
              variant="plain"
              aria-label="Show trail"
              data-testid={`image-job-trail-btn-${job.id}`}
              onClick={() => setIsTrailOpen(true)}
            >
              <TimelineIcon />
            </IconButton>
          )}
        </Stack>
      </CardContent>
      {fileId && (
        <StudioTrailDialog
          fileId={fileId}
          open={isTrailOpen}
          onClose={() => setIsTrailOpen(false)}
          onRestore={onRestore}
        />
      )}
    </Card>
  );
};

export default ImageJobCard;
