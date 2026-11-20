import StudioFeatureGate from '@client/app/components/Studio/v2/StudioFeatureGate';
import StudioLibraryPage from '@client/app/components/Studio/v2/StudioLibraryPage';

const StudioLibraryRoute = () => (
  <StudioFeatureGate feature="createV2">
    <StudioLibraryPage />
  </StudioFeatureGate>
);

export default StudioLibraryRoute;
