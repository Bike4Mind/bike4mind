import type { ReactNode } from 'react';
import { CircularProgress } from '@mui/joy';
import { notFound } from '@tanstack/react-router';
import type { StudioFeature } from '@bike4mind/common';
import { useStudioFeature, useStudioFeaturesLoading } from '../useStudioFeature';

/**
 * Renders a Create v2-only page once `feature` is open to the viewer. Closed, it throws the router's notFound, so the
 * URL answers exactly as it did before the page existed (an unknown /studio/<medium> 404s from the param parser).
 */
const StudioFeatureGate = ({ feature, children }: { feature: StudioFeature; children: ReactNode }) => {
  const isOpen = useStudioFeature(feature);
  const isLoading = useStudioFeaturesLoading();
  if (isOpen) return <>{children}</>;
  if (isLoading) return <CircularProgress size="sm" data-testid="studio-feature-gate-loading" />;
  throw notFound();
};

export default StudioFeatureGate;
