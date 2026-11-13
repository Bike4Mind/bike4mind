import { styled } from '@mui/system';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { studioColor } from '../design/studioTokens';
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

  return (
    <StudioV2Frame area="create" testId={`${testId}-page`} rail={<StudioMediumRail medium={medium} />}>
      <Workspace testId={testId} />
      <SectionTitle data-testid="studio-gallery-title">{galleryTitle}</SectionTitle>
      <Gallery />
    </StudioV2Frame>
  );
};

export default StudioCreateV2Page;
