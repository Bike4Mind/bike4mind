import { StudioLibrary } from '@client/app/components/Files/StudioLibrary';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import StudioV2Frame from './StudioV2Frame';

/** The Studio Library: the user's generated and uploaded files, browsed inline. */
const StudioLibraryPage = () => {
  useDocumentTitle('Library Studio');
  return (
    <StudioV2Frame area="library" testId="studio-library-page">
      <StudioLibrary />
    </StudioV2Frame>
  );
};

export default StudioLibraryPage;
