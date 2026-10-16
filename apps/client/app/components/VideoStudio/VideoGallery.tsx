import StudioGallery from '@client/app/components/Studio/StudioGallery';
import { useVideoGenerations } from '@client/app/hooks/data/videoGenerations';
import VideoJobCard from './VideoJobCard';

const VideoGallery = () => (
  <StudioGallery testId="video-gallery" noun="videos" query={useVideoGenerations()} Card={VideoJobCard} />
);

export default VideoGallery;
