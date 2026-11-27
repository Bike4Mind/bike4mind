import ProductionEditorPage from '@client/app/components/Studio/productions/ProductionEditorPage';
import StudioFeatureGate from '@client/app/components/Studio/v2/StudioFeatureGate';

const StudioProductionEditorRoute = ({ compositionId }: { compositionId: string }) => (
  <StudioFeatureGate feature="productions">
    <ProductionEditorPage compositionId={compositionId} />
  </StudioFeatureGate>
);

export default StudioProductionEditorRoute;
