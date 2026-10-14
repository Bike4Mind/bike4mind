import { Stack } from '@mui/joy';
import type { FC } from 'react';
import type { GenerationJobRef } from '@bike4mind/common';
import VideoJobCard from '../VideoStudio/VideoJobCard';
import MusicJobCard from './MusicJobCard';

export const GeneratedJobs: FC<{ jobs: readonly GenerationJobRef[] | undefined }> = ({ jobs }) => {
  if (!jobs?.length) return null;
  return (
    <Stack spacing={1} data-testid="generated-jobs-list">
      {jobs.map(job =>
        job.kind === 'music' ? (
          <MusicJobCard key={job.id} jobId={job.id} />
        ) : (
          <VideoJobCard key={job.id} jobId={job.id} />
        )
      )}
    </Stack>
  );
};
