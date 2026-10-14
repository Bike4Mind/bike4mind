import type { ComponentType } from 'react';
import VideoGallery from '@client/app/components/VideoStudio/VideoGallery';
import VideoStudioWorkspace from '@client/app/components/VideoStudio/VideoStudioWorkspace';
import type { StudioModality } from './studioModality';

export type StudioModalityDefinition = {
  title: string;
  galleryTitle: string;
  // `<testId>-page`; the workspace reuses it for its own states.
  testId: string;
  // Model picker and CapabilityForm, gated on the modality's usable models.
  Workspace: ComponentType;
  Gallery: ComponentType;
};

export const STUDIO_MODALITY_DEFINITIONS: Record<StudioModality, StudioModalityDefinition> = {
  video: {
    title: 'Video Studio',
    galleryTitle: 'Your videos',
    testId: 'video-studio',
    Workspace: VideoStudioWorkspace,
    Gallery: VideoGallery,
  },
};
