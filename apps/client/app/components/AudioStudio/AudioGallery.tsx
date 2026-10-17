import StudioGallery from '@client/app/components/Studio/StudioGallery';
import type { AudioGenMode } from '@client/app/stores/useAudioGenSettings';
import GeneratedAudioCard from './GeneratedAudioCard';
import { useRecentGeneratedAudio } from './useRecentGeneratedAudio';

const AudioGallery = ({ mode, testId, noun }: { mode: AudioGenMode; testId: string; noun: string }) => (
  <StudioGallery
    testId={testId}
    noun={noun}
    query={useRecentGeneratedAudio(mode)}
    renderCard={file => <GeneratedAudioCard mode={mode} file={file} />}
  />
);

export const SpeechGallery = () => <AudioGallery mode="tts" testId="speech-gallery" noun="speech clips" />;

export const SoundEffectsGallery = () => (
  <AudioGallery mode="sound-effects" testId="sound-effects-gallery" noun="sound effects" />
);
