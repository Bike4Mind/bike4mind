import StudioFeatureGate from '@client/app/components/Studio/v2/StudioFeatureGate';
import StudioProductionsPage from '@client/app/components/Studio/v2/StudioProductionsPage';

const StudioProductionsRoute = () => (
  <StudioFeatureGate feature="productions">
    <StudioProductionsPage />
  </StudioFeatureGate>
);

export default StudioProductionsRoute;
