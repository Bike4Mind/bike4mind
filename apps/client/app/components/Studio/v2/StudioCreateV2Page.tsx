import { useEffect } from 'react';
import { styled } from '@mui/system';
import { useNavigate } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { studioColor } from '../design/studioTokens';
import { useStudioRestore } from '../restore/studioRestore';
import type { StudioTrailRestore } from '../trail/StudioTrail';
import type { StudioMedium } from '../studioModality';
import StudioMediumRail from './StudioMediumRail';
import StudioV2Frame from './StudioV2Frame';
import { STUDIO_CREATE_DEFINITIONS } from './studioCreateMedia';

const SectionTitle = styled('h2')({
  margin: '4px 0 0',
  fontSize: '15px',
  fontWeight: 600,
  lineHeight: 1.3,
  color: studioColor('text-strong'),
});

/** Create v2: one medium at a time, picked from the rail, with that medium's form and gallery beside it. */
const StudioCreateV2Page = ({ medium }: { medium: StudioMedium }) => {
  const { railLabel, galleryTitle, testId, Workspace, Gallery } = STUDIO_CREATE_DEFINITIONS[medium];
  useDocumentTitle(`${railLabel} Studio`);
  const navigate = useNavigate();
  const requestRestore = useStudioRestore(state => state.requestRestore);
  // A restore whose form never took it (no models there, or the user moved on first) must not land later.
  useEffect(() => {
    const { pending, clear } = useStudioRestore.getState();
    if (pending && pending.medium !== medium) clear();
  }, [medium]);
  // The take's medium may not be this one: the form there picks the request up once it mounts.
  const restore: StudioTrailRestore = request => {
    requestRestore(request);
    if (request.medium !== medium) void navigate({ to: '/studio/$modality', params: { modality: request.medium } });
  };

  return (
    <StudioV2Frame area="create" medium={medium} testId={`${testId}-page`} rail={<StudioMediumRail medium={medium} />}>
      <Workspace testId={testId} />
      <SectionTitle data-testid="studio-gallery-title">{galleryTitle}</SectionTitle>
      <Gallery onRestore={restore} />
    </StudioV2Frame>
  );
};

export default StudioCreateV2Page;
