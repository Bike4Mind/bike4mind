import type { IncidentSurface } from '@bike4mind/common';

export const SURFACE_LABELS: Record<IncidentSurface, string> = {
  generation: 'Generation',
  edit: 'Edit',
  upload: 'Upload',
};

export const surfaceLabel = (surface: IncidentSurface | null | undefined) =>
  surface ? SURFACE_LABELS[surface] : 'Unknown';
