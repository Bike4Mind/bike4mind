import type { ComponentType } from 'react';
import { SoundEffectsGallery, SpeechGallery } from '@client/app/components/AudioStudio/AudioGallery';
import {
  SoundEffectsStudioWorkspace,
  SpeechStudioWorkspace,
} from '@client/app/components/AudioStudio/AudioStudioWorkspace';
import MusicGallery from '@client/app/components/MusicStudio/MusicGallery';
import MusicStudioWorkspace from '@client/app/components/MusicStudio/MusicStudioWorkspace';
import VideoGallery from '@client/app/components/VideoStudio/VideoGallery';
import VideoStudioWorkspace from '@client/app/components/VideoStudio/VideoStudioWorkspace';
import type { StudioModality } from './studioModality';

export type StudioModalityDefinition = {
  // The Studio page's tab for this modality.
  tabLabel: string;
  galleryTitle: string;
  // `<testId>-page`, and the prefix of the workspace's loading, error and empty states.
  testId: string;
  // The modality's form, gated on its usable models (or, for speech and sound effects, its usable providers).
  Workspace: ComponentType<{ testId: string }>;
  Gallery: ComponentType;
};

export const STUDIO_MODALITY_DEFINITIONS: Record<StudioModality, StudioModalityDefinition> = {
  video: {
    tabLabel: 'Video',
    galleryTitle: 'Your videos',
    testId: 'video-studio',
    Workspace: VideoStudioWorkspace,
    Gallery: VideoGallery,
  },
  music: {
    tabLabel: 'Music',
    galleryTitle: 'Your songs',
    testId: 'music-studio',
    Workspace: MusicStudioWorkspace,
    Gallery: MusicGallery,
  },
  speech: {
    tabLabel: 'Speech',
    galleryTitle: 'Recent speech',
    testId: 'speech-studio',
    Workspace: SpeechStudioWorkspace,
    Gallery: SpeechGallery,
  },
  'sound-effects': {
    tabLabel: 'Sound effects',
    galleryTitle: 'Recent sound effects',
    testId: 'sound-effects-studio',
    Workspace: SoundEffectsStudioWorkspace,
    Gallery: SoundEffectsGallery,
  },
};
