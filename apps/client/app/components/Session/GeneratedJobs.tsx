import { Stack } from '@mui/joy';
import type { FC } from 'react';
import type { GenerationJobKind, GenerationJobRef } from '@bike4mind/common';
import VideoJobCard from '../VideoStudio/VideoJobCard';
import MusicJobCard from './MusicJobCard';

const JOB_CARDS: Record<GenerationJobKind, FC<{ jobId: string }>> = {
  video: VideoJobCard,
  music: MusicJobCard,
};

export const GeneratedJobs: FC<{ jobs: readonly GenerationJobRef[] | undefined }> = ({ jobs }) => {
  if (!jobs?.length) return null;
  return (
    <Stack spacing={1} data-testid="generated-jobs-list">
      {jobs.map(job => {
        const JobCard = JOB_CARDS[job.kind];
        return <JobCard key={job.id} jobId={job.id} />;
      })}
    </Stack>
  );
};
