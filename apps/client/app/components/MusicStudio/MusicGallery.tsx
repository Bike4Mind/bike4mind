import MusicJobCard from '@client/app/components/Session/MusicJobCard';
import StudioGallery from '@client/app/components/Studio/StudioGallery';
import { useMusicGenerations } from '@client/app/hooks/data/musicGenerations';

const MusicGallery = () => (
  <StudioGallery testId="music-gallery" noun="songs" query={useMusicGenerations()} Card={MusicJobCard} />
);

export default MusicGallery;
