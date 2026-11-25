import type { ReactNode } from 'react';
import type { StudioMediaKind } from '@shared/studio';
import { MediumGlyph } from './design/MediumGlyph';

/** The Create media in web Studio's order (studioCreateMedia.tsx), with a one-line hint for the picker. */
export const STUDIO_MEDIA: readonly { kind: StudioMediaKind; label: string; hint: string; icon: ReactNode }[] = [
  { kind: 'image', label: 'Image', hint: 'Stills and edits', icon: <MediumGlyph kind="image" /> },
  { kind: 'video', label: 'Video', hint: 'Text or image to clip', icon: <MediumGlyph kind="video" /> },
  { kind: 'music', label: 'Music', hint: 'Beds, stingers, songs', icon: <MediumGlyph kind="music" /> },
  { kind: 'speech', label: 'Voice', hint: 'Narration and dialogue', icon: <MediumGlyph kind="speech" /> },
  { kind: 'sound-effect', label: 'Sound FX', hint: 'One-shots and foley', icon: <MediumGlyph kind="sound-effect" /> },
];

export const mediaLabel = (kind: StudioMediaKind) => STUDIO_MEDIA.find(medium => medium.kind === kind)?.label ?? kind;
