import StudioGallery from '@client/app/components/Studio/StudioGallery';
import { useGenerationJobs } from '@client/app/hooks/data/generationJobs';
import type { StudioTrailRestore } from '@client/app/components/Studio/trail/StudioTrail';
import ImageJobCard from './ImageJobCard';

/** `onRestore` reaches each take's trail; without it the trail is read-only. */
const ImageGallery = ({ onRestore }: { onRestore?: StudioTrailRestore }) => (
  <StudioGallery
    testId="image-gallery"
    noun="images"
    query={useGenerationJobs('image')}
    variant="takes"
    renderCard={job => <ImageJobCard job={job} onRestore={onRestore} />}
  />
);

export default ImageGallery;
