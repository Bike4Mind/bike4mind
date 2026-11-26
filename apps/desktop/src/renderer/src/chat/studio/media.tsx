import type { ReactNode } from 'react';
import type { StudioMediaKind } from '@shared/studio';
import { MediumGlyph } from './design/MediumGlyph';

type StudioMedium = { kind: StudioMediaKind; label: string; hint: string; galleryTitle: string; icon: ReactNode };

/**
 * The Create media in web Studio's order (studioCreateMedia.tsx), with a one-line hint for the picker and the
 * gallery title web's Create shows under each medium's form (studioModalityRegistry.ts).
 */
export const STUDIO_MEDIA: readonly StudioMedium[] = [
  {
    kind: 'image',
    label: 'Image',
    hint: 'Stills and edits',
    galleryTitle: 'Your images',
    icon: <MediumGlyph kind="image" />,
  },
  {
    kind: 'video',
    label: 'Video',
    hint: 'Text or image to clip',
    galleryTitle: 'Your videos',
    icon: <MediumGlyph kind="video" />,
  },
  {
    kind: 'music',
    label: 'Music',
    hint: 'Beds, stingers, songs',
    galleryTitle: 'Your songs',
    icon: <MediumGlyph kind="music" />,
  },
  {
    kind: 'speech',
    label: 'Voice',
    hint: 'Narration and dialogue',
    galleryTitle: 'Recent speech',
    icon: <MediumGlyph kind="speech" />,
  },
  {
    kind: 'sound-effect',
    label: 'Sound FX',
    hint: 'One-shots and foley',
    galleryTitle: 'Recent sound effects',
    icon: <MediumGlyph kind="sound-effect" />,
  },
];

export const studioMedium = (kind: StudioMediaKind) => STUDIO_MEDIA.find(medium => medium.kind === kind);

export const mediaLabel = (kind: StudioMediaKind) => STUDIO_MEDIA.find(medium => medium.kind === kind)?.label ?? kind;
