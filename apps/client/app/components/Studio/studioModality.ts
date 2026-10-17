import { notFound } from '@tanstack/react-router';

// Kept apart from the component registry (studioModalityRegistry) so the router can parse the param without
// pulling any Studio component into its bundle. Adding a modality: append it here, then TypeScript forces its entry.
// Order is tab order; the first modality with a usable model is where the sidenav's Studio entry opens.
export const STUDIO_MODALITIES = ['video', 'music', 'speech', 'sound-effects'] as const;
export type StudioModality = (typeof STUDIO_MODALITIES)[number];

export const isStudioModality = (value: string): value is StudioModality =>
  STUDIO_MODALITIES.some(modality => modality === value);

/** The `/studio/$modality` param parser: an unknown modality is a 404, not an empty page. */
export const parseStudioModality = (value: string): StudioModality => {
  if (!isStudioModality(value)) throw notFound();
  return value;
};

/** The first modality the user can generate with, or undefined when none has a usable model. */
export const firstUsableStudioModality = (usable: Record<StudioModality, boolean>): StudioModality | undefined =>
  STUDIO_MODALITIES.find(modality => usable[modality]);
