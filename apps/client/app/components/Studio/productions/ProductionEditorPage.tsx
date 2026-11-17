import { useState } from 'react';
import { Button, CircularProgress, Typography } from '@mui/joy';
import { useIsMutating } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import {
  compositionErrorMessage,
  studioCompositionKeys,
  useStudioComposition,
} from '@client/app/hooks/data/studioCompositions';
import { StudioPanel } from '../design/StudioPanel';
import StudioV2Frame from '../v2/StudioV2Frame';
import ProductionEditor from './ProductionEditor';

/** /studio/productions/$compositionId: one production in the timeline editor. */
const ProductionEditorPage = ({ compositionId }: { compositionId: string }) => {
  const composition = useStudioComposition(compositionId);
  // A save from a previous visit may still be in flight; the editor starts its draft from this data once, so it
  // waits for that save to land in the cache. Latched, so the editor's own saves never unmount it.
  const savesInFlight = useIsMutating({ mutationKey: studioCompositionKeys.update(compositionId) });
  const [isReady, setIsReady] = useState(false);
  if (!isReady && savesInFlight === 0 && composition.data) setIsReady(true);
  useDocumentTitle(composition.data ? `${composition.data.title} - Productions Studio` : 'Productions Studio');

  return (
    <StudioV2Frame area="productions" testId="production-editor-page">
      <Button
        component={Link}
        to="/studio/productions"
        size="sm"
        variant="plain"
        sx={{ alignSelf: 'flex-start' }}
        data-testid="production-back-link"
      >
        All productions
      </Button>
      {composition.isPending || (composition.data && !isReady) ? (
        <CircularProgress size="sm" data-testid="production-editor-loading" />
      ) : composition.isError ? (
        <StudioPanel testId="production-editor-error">
          <Typography level="body-sm">
            {isAxiosError(composition.error) && composition.error.response?.status === 404
              ? 'This production does not exist or is not yours.'
              : compositionErrorMessage(composition.error)}
          </Typography>
        </StudioPanel>
      ) : (
        // Keyed so opening another production starts a fresh draft instead of carrying this one's state over.
        <ProductionEditor key={composition.data.id} composition={composition.data} />
      )}
    </StudioV2Frame>
  );
};

export default ProductionEditorPage;
