import MusicJobCard from '@client/app/components/Session/MusicJobCard';
import StudioGallery from '@client/app/components/Studio/StudioGallery';
import type { StudioTrailRestore } from '@client/app/components/Studio/trail/StudioTrail';
import { useMusicGenerations } from '@client/app/hooks/data/musicGenerations';

/** `onRestore` (Create v2 only) adds each take's trail. */
const MusicGallery = ({ onRestore }: { onRestore?: StudioTrailRestore }) => (
  <StudioGallery
    testId="music-gallery"
    noun="songs"
    query={useMusicGenerations()}
    renderCard={job => <MusicJobCard jobId={job.id} onRestore={onRestore} />}
  />
);

export default MusicGallery;
