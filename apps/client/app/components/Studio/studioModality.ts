import { notFound } from '@tanstack/react-router';

// Kept apart from the component registry (studioModalityRegistry) so the router can parse the param without
// pulling any Studio component into its bundle. Adding a modality: append it here, then TypeScript forces its entry.
export const STUDIO_MODALITIES = ['video'] as const;
export type StudioModality = (typeof STUDIO_MODALITIES)[number];

export const isStudioModality = (value: string): value is StudioModality =>
  STUDIO_MODALITIES.some(modality => modality === value);

/** The `/studio/$modality` param parser: an unknown modality is a 404, not an empty page. */
export const parseStudioModality = (value: string): StudioModality => {
  if (!isStudioModality(value)) throw notFound();
  return value;
};
