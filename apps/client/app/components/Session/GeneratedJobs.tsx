import { Box, Stack } from '@mui/joy';
import type { FC } from 'react';
import type { GenerationJobRef, QuestGenerationJobKind } from '@bike4mind/common';
import VideoJobCard from '../VideoStudio/VideoJobCard';
import ImageJobCard from './ImageJobCard';
import MusicJobCard from './MusicJobCard';

const JOB_CARDS: Record<QuestGenerationJobKind, FC<{ jobId: string }>> = {
  video: VideoJobCard,
  music: MusicJobCard,
  image: ImageJobCard,
};

type JobBlock = { kind: QuestGenerationJobKind; jobs: GenerationJobRef[] };

// One tool call with n images stores n consecutive image refs; they render as one grid, other kinds one card each.
const toBlocks = (jobs: readonly GenerationJobRef[]): JobBlock[] =>
  jobs.reduce<JobBlock[]>((blocks, job) => {
    const last = blocks.at(-1);
    if (job.kind === 'image' && last?.kind === 'image') last.jobs.push(job);
    else blocks.push({ kind: job.kind, jobs: [job] });
    return blocks;
  }, []);

export const GeneratedJobs: FC<{ jobs: readonly GenerationJobRef[] | undefined }> = ({ jobs }) => {
  if (!jobs?.length) return null;
  return (
    <Stack spacing={1} data-testid="generated-jobs-list">
      {toBlocks(jobs).map(block => {
        const JobCard = JOB_CARDS[block.kind];
        if (block.kind !== 'image') return <JobCard key={block.jobs[0].id} jobId={block.jobs[0].id} />;
        return (
          <Box
            key={block.jobs[0].id}
            data-testid="generated-jobs-image-grid"
            sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))' }}
          >
            {block.jobs.map(job => (
              <JobCard key={job.id} jobId={job.id} />
            ))}
          </Box>
        );
      })}
    </Stack>
  );
};
