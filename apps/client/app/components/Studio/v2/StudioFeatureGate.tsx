import type { ReactNode } from 'react';
import { CircularProgress } from '@mui/joy';
import type { StudioFeature } from '@bike4mind/common';
import NotFound from '@client/app/components/NotFound';
import { useStudioFeatureAccess, useStudioFeaturesLoading } from '../useStudioFeature';
import StudioUpgradePrompt from './StudioUpgradePrompt';

/**
 * Renders a Create v2-only page once `feature` is open to the viewer. A free viewer of a paid feature gets the
 * upgrade prompt. Closed, it shows the router's default not-found page (router.tsx defaultNotFoundComponent), so
 * the URL looks as it did before the page existed. Rendered, not thrown: a notFound() thrown from this lazy route
 * component lands on the error boundary instead.
 */
const StudioFeatureGate = ({ feature, children }: { feature: StudioFeature; children: ReactNode }) => {
  const access = useStudioFeatureAccess(feature);
  const isLoading = useStudioFeaturesLoading(feature);
  if (access === 'open') return <>{children}</>;
  if (isLoading) return <CircularProgress size="sm" data-testid="studio-feature-gate-loading" />;
  if (access === 'upgrade') return <StudioUpgradePrompt feature={feature} />;
  return <NotFound />;
};

export default StudioFeatureGate;
