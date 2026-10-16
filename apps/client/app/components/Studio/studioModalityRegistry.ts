import type { ComponentType } from 'react';
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
  // Model picker and CapabilityForm, gated on the modality's usable models.
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
};
