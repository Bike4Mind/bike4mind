import type { ReactNode } from 'react';
import { CircularProgress } from '@mui/joy';
import type { StudioFeature } from '@bike4mind/common';
import NotFound from '@client/app/components/NotFound';
import { useStudioFeature, useStudioFeaturesLoading } from '../useStudioFeature';

/**
 * Renders a Create v2-only page once `feature` is open to the viewer. Closed, it shows the router's default
 * not-found page (router.tsx defaultNotFoundComponent), so the URL looks as it did before the page existed. Rendered,
 * not thrown: a notFound() thrown from this lazy route component lands on the error boundary instead.
 */
const StudioFeatureGate = ({ feature, children }: { feature: StudioFeature; children: ReactNode }) => {
  const isOpen = useStudioFeature(feature);
  const isLoading = useStudioFeaturesLoading();
  if (isOpen) return <>{children}</>;
  if (isLoading) return <CircularProgress size="sm" data-testid="studio-feature-gate-loading" />;
  return <NotFound />;
};

export default StudioFeatureGate;
