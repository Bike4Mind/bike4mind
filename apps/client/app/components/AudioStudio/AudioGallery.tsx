import StudioGallery from '@client/app/components/Studio/StudioGallery';
import type { StudioTrailRestore } from '@client/app/components/Studio/trail/StudioTrail';
import type { AudioGenMode } from '@client/app/stores/useAudioGenSettings';
import GeneratedAudioCard from './GeneratedAudioCard';
import { useRecentGeneratedAudio } from './useRecentGeneratedAudio';

type AudioGalleryProps = {
  mode: AudioGenMode;
  testId: string;
  noun: string;
  // Create v2 only: adds each take's trail.
  onRestore?: StudioTrailRestore;
};

const AudioGallery = ({ mode, testId, noun, onRestore }: AudioGalleryProps) => (
  <StudioGallery
    testId={testId}
    noun={noun}
    query={useRecentGeneratedAudio(mode)}
    renderCard={file => <GeneratedAudioCard mode={mode} file={file} onRestore={onRestore} />}
  />
);

export const SpeechGallery = ({ onRestore }: { onRestore?: StudioTrailRestore }) => (
  <AudioGallery mode="tts" testId="speech-gallery" noun="speech clips" onRestore={onRestore} />
);

export const SoundEffectsGallery = ({ onRestore }: { onRestore?: StudioTrailRestore }) => (
  <AudioGallery mode="sound-effects" testId="sound-effects-gallery" noun="sound effects" onRestore={onRestore} />
);
