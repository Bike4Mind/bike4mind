import { Card, Typography } from '@mui/joy';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import StudioV2Frame from './StudioV2Frame';

/** Placeholder for Productions, where ads and films will be assembled from Create's assets. */
const StudioProductionsPage = () => {
  useDocumentTitle('Productions Studio');
  return (
    <StudioV2Frame area="productions" testId="studio-productions-page">
      <Card variant="soft" data-testid="studio-productions-coming-soon">
        <Typography level="title-md">Productions are coming soon</Typography>
        <Typography level="body-sm">Assemble ads and films from the images, video and audio you create.</Typography>
      </Card>
    </StudioV2Frame>
  );
};

export default StudioProductionsPage;
