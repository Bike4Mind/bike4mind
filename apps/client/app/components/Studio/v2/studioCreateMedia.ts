import type { StudioFeature } from '@bike4mind/common';
import ImageGallery from '@client/app/components/ImageStudio/ImageGallery';
import ImageStudioWorkspace from '@client/app/components/ImageStudio/ImageStudioWorkspace';
import { STUDIO_MODALITY_DEFINITIONS, type StudioModalityDefinition } from '../studioModalityRegistry';
import type { StudioMedium, StudioV2OnlyMedium } from '../studioModality';

export type StudioCreateMediumDefinition = StudioModalityDefinition & {
  // The medium's entry in the Create rail; Create v2 renames some of the legacy tabs.
  railLabel: string;
};

// Rail order. Image leads: it is the medium Create v2 adds.
export const STUDIO_CREATE_MEDIA = [
  'image',
  'video',
  'music',
  'speech',
  'sound-effects',
] as const satisfies readonly StudioMedium[];

// The flag a v2-only medium opens behind, on top of Create v2 itself (see STUDIO_FEATURE_PARENT).
export const STUDIO_V2_ONLY_MEDIUM_FEATURE: Record<StudioV2OnlyMedium, StudioFeature> = { image: 'image' };

export const STUDIO_CREATE_DEFINITIONS: Record<StudioMedium, StudioCreateMediumDefinition> = {
  image: {
    tabLabel: 'Image',
    railLabel: 'Image',
    galleryTitle: 'Your images',
    testId: 'image-studio',
    Workspace: ImageStudioWorkspace,
    Gallery: ImageGallery,
  },
  video: { ...STUDIO_MODALITY_DEFINITIONS.video, railLabel: 'Video' },
  music: { ...STUDIO_MODALITY_DEFINITIONS.music, railLabel: 'Music' },
  speech: { ...STUDIO_MODALITY_DEFINITIONS.speech, railLabel: 'Voice' },
  'sound-effects': { ...STUDIO_MODALITY_DEFINITIONS['sound-effects'], railLabel: 'Sound FX' },
};
