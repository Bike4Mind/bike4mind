import { Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useStudioRestore } from '../restore/studioRestore';
import type { StudioTrailRestore } from '../trail/StudioTrail';
import type { StudioMedium } from '../studioModality';
import StudioMediumRail from './StudioMediumRail';
import StudioV2Frame from './StudioV2Frame';
import { STUDIO_CREATE_DEFINITIONS } from './studioCreateMedia';

/** Create v2: one medium at a time, picked from the rail, with that medium's form and gallery beside it. */
const StudioCreateV2Page = ({ medium }: { medium: StudioMedium }) => {
  const { railLabel, galleryTitle, testId, Workspace, Gallery } = STUDIO_CREATE_DEFINITIONS[medium];
  useDocumentTitle(`${railLabel} Studio`);
  const navigate = useNavigate();
  const requestRestore = useStudioRestore(state => state.requestRestore);
  // The take's medium may not be this one: the form there picks the request up once it mounts.
  const restore: StudioTrailRestore = request => {
    requestRestore(request);
    if (request.medium !== medium) void navigate({ to: '/studio/$modality', params: { modality: request.medium } });
  };

  return (
    <StudioV2Frame area="create" testId={`${testId}-page`}>
      <Stack direction={{ xs: 'column', md: 'row' }} gap={3} alignItems={{ md: 'flex-start' }}>
        <StudioMediumRail medium={medium} />
        <Stack gap={3} sx={{ flex: 1, minWidth: 0 }}>
          <Workspace testId={testId} />
          <Typography level="title-lg">{galleryTitle}</Typography>
          <Gallery onRestore={restore} />
        </Stack>
      </Stack>
    </StudioV2Frame>
  );
};

export default StudioCreateV2Page;
