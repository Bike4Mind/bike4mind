import { AspectRatio, Card, CardContent, Chip, CircularProgress, Stack, Typography } from '@mui/joy';
import type { GenerationJobState } from '@bike4mind/common';
import { useGetFabFile } from '@client/app/hooks/data/fabFileQueries';
import type { StudioImageJob } from '@client/app/hooks/data/studioImageJobs';

const LIVE_LABELS: Partial<Record<GenerationJobState, string>> = {
  pending: 'Queued',
  running: 'Generating',
  storing: 'Saving',
};

// GET /api/files/:id signs the file, so the saved image renders straight from its record.
const ImageJobPreview = ({ fileId, prompt }: { fileId: string; prompt: string }) => {
  const file = useGetFabFile(fileId);
  if (!file.data?.fileUrl) return <CircularProgress size="sm" data-testid="image-job-image-loading" />;
  return <img src={file.data.fileUrl} alt={prompt} loading="lazy" data-testid="image-job-image" />;
};

const JobBody = ({ job }: { job: StudioImageJob }) => {
  const liveLabel = LIVE_LABELS[job.state];
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
      <ImageJobPreview fileId={job.output.fileId} prompt={job.request.prompt} />
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

/** One image job in the gallery: live while it renders, the image once saved, the fixed error text if it failed. */
const ImageJobCard = ({ job }: { job: StudioImageJob }) => (
  <Card variant="outlined" data-testid={`image-job-card-${job.id}`} data-state={job.state}>
    <AspectRatio ratio="1" objectFit="cover" variant="soft">
      <JobBody job={job} />
    </AspectRatio>
    <CardContent>
      <Typography
        level="body-sm"
        sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
      >
        {job.request.prompt}
      </Typography>
      <Chip size="sm" variant="soft" sx={{ alignSelf: 'flex-start', mt: 0.5 }}>
        {job.request.model}
      </Chip>
    </CardContent>
  </Card>
);

export default ImageJobCard;
