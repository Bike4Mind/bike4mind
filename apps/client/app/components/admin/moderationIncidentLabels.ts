import type { IncidentSurface } from '@bike4mind/common';

export const SURFACE_LABELS: Record<IncidentSurface, string> = {
  generation: 'Generation',
  edit: 'Edit',
  upload: 'Upload',
};

export const surfaceLabel = (surface: IncidentSurface | null | undefined) =>
  surface ? SURFACE_LABELS[surface] : 'Unknown';

// Rekognition reports confidence as a percentage (0-100).
export const formatConfidence = (confidence: number) => `${confidence.toFixed(1)}%`;

export const VERDICT_EXPLANATIONS = {
  false_positive:
    'Closes the incident without a report and takes it out of the queue. It stays on file, and a report can still be recorded later.',
  confirmed:
    'Records that you filed a report on the external reporting web form, with the report id it gave you. This page does not file a report for you, and the record cannot be undone here.',
} as const;
