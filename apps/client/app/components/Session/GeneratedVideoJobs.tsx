import { Stack } from '@mui/joy';
import type { FC } from 'react';
import VideoJobCard from '../VideoStudio/VideoJobCard';

export const GeneratedVideoJobs: FC<{ jobIds: readonly string[] | undefined }> = ({ jobIds }) => {
  if (!jobIds?.length) return null;
  return (
    <Stack spacing={1} data-testid="generated-video-jobs-list">
      {jobIds.map(jobId => (
        <VideoJobCard key={jobId} jobId={jobId} />
      ))}
    </Stack>
  );
};
