import StudioGallery from '@client/app/components/Studio/StudioGallery';
import { useStudioImageJobs } from '@client/app/hooks/data/studioImageJobs';
import ImageJobCard from './ImageJobCard';

const ImageGallery = () => (
  <StudioGallery
    testId="image-gallery"
    noun="images"
    query={useStudioImageJobs()}
    renderCard={job => <ImageJobCard job={job} />}
  />
);

export default ImageGallery;
