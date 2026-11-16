import StudioGallery from '@client/app/components/Studio/StudioGallery';
import { useStudioImageJobs } from '@client/app/hooks/data/studioImageJobs';
import type { StudioTrailRestore } from '@client/app/components/Studio/trail/StudioTrail';
import ImageJobCard from './ImageJobCard';

/** `onRestore` reaches each take's trail; without it the trail is read-only. */
const ImageGallery = ({ onRestore }: { onRestore?: StudioTrailRestore }) => (
  <StudioGallery
    testId="image-gallery"
    noun="images"
    query={useStudioImageJobs()}
    renderCard={job => <ImageJobCard job={job} onRestore={onRestore} />}
  />
);

export default ImageGallery;
