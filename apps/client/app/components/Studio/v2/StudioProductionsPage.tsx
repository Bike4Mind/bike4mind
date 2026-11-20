import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import ProductionsList from '../productions/ProductionsList';
import StudioV2Frame from './StudioV2Frame';

/** Productions, where ads and films are assembled on a timeline from Create's assets. */
const StudioProductionsPage = () => {
  useDocumentTitle('Productions Studio');
  return (
    <StudioV2Frame area="productions" testId="studio-productions-page">
      <ProductionsList />
    </StudioV2Frame>
  );
};

export default StudioProductionsPage;
