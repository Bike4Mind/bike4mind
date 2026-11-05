import type { IncidentReviewStatus, IncidentSurface, ModerationLabelHit } from '@bike4mind/common';

export const SURFACE_LABELS: Record<IncidentSurface, string> = {
  generation: 'Generation',
  edit: 'Edit',
  upload: 'Upload',
};

export const surfaceLabel = (surface: IncidentSurface | null | undefined) =>
  surface ? SURFACE_LABELS[surface] : 'Unknown';

export const REVIEW_STATUS_LABELS: Record<IncidentReviewStatus, string> = {
  pending_review: 'Needs review',
  confirmed_csam: 'Report stuck',
  false_positive: 'False positive',
  no_action: 'No action',
  reported: 'Reported',
};

/** Classifier confidence is stored as a percentage (0-100). */
export const formatConfidence = (confidence: number) => `${confidence.toFixed(1)}%`;

/** `Explicit Nudity (Explicit) 97.5%`; the parent is left out when there is none. */
export const formatLabel = (label: ModerationLabelHit) =>
  `${label.name}${label.parentName ? ` (${label.parentName})` : ''} ${formatConfidence(label.confidence)}`;
