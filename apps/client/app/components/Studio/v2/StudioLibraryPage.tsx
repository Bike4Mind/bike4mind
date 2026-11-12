import { Button, Card, Typography } from '@mui/joy';
import { useFileBrowser } from '@client/app/components/Files/fileBrowserStore';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import StudioV2Frame from './StudioV2Frame';

/** Stand-in for the Studio Library: everything Studio generates is saved to Files, so it points there for now. */
const StudioLibraryPage = () => {
  useDocumentTitle('Library Studio');
  const openFiles = useFileBrowser(state => state.setOpen);
  return (
    <StudioV2Frame area="library" testId="studio-library-page">
      <Card variant="soft" data-testid="studio-library-stub">
        <Typography level="title-md">Your generated media lives in Files</Typography>
        <Typography level="body-sm">Every image, video and sound you create in Studio is saved to Files.</Typography>
        <Button
          variant="solid"
          sx={{ alignSelf: 'flex-start' }}
          onClick={() => openFiles(true)}
          data-testid="studio-library-open-files-btn"
        >
          Open Files
        </Button>
      </Card>
    </StudioV2Frame>
  );
};

export default StudioLibraryPage;
