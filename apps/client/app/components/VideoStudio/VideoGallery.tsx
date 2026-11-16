import StudioGallery from '@client/app/components/Studio/StudioGallery';
import { useVideoGenerations } from '@client/app/hooks/data/videoGenerations';
import type { StudioTrailRestore } from '@client/app/components/Studio/trail/StudioTrail';
import VideoJobCard from './VideoJobCard';

/** `onRestore` (Create v2 only) adds each take's trail. */
const VideoGallery = ({ onRestore }: { onRestore?: StudioTrailRestore }) => (
  <StudioGallery
    testId="video-gallery"
    noun="videos"
    query={useVideoGenerations()}
    renderCard={job => <VideoJobCard jobId={job.id} onRestore={onRestore} />}
  />
);

export default VideoGallery;
