import StudioGallery from '@client/app/components/Studio/StudioGallery';
import { useGenerationJobs } from '@client/app/hooks/data/generationJobs';
import type { StudioTrailRestore } from '@client/app/components/Studio/trail/StudioTrail';
import VideoJobCard from './VideoJobCard';

/** `onRestore` (Create v2 only) adds each take's trail. */
const VideoGallery = ({ onRestore }: { onRestore?: StudioTrailRestore }) => (
  <StudioGallery
    testId="video-gallery"
    noun="videos"
    query={useGenerationJobs('video')}
    renderCard={job => <VideoJobCard jobId={job.id} onRestore={onRestore} />}
  />
);

export default VideoGallery;
