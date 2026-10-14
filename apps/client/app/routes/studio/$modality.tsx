import { Stack, Typography } from '@mui/joy';
import PageFrame from '@client/app/components/common/PageFrame';
import type { StudioModality } from '@client/app/components/Studio/studioModality';
import { STUDIO_MODALITY_DEFINITIONS } from '@client/app/components/Studio/studioModalityRegistry';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

const StudioPage = ({ modality }: { modality: StudioModality }) => {
  const { title, galleryTitle, testId, Workspace, Gallery } = STUDIO_MODALITY_DEFINITIONS[modality];
  useDocumentTitle(title);

  return (
    <PageFrame testId={`${testId}-page`}>
      <Stack gap={3}>
        <Typography level="h2">{title}</Typography>
        <Workspace testId={testId} />
        <Typography level="title-lg">{galleryTitle}</Typography>
        <Gallery />
      </Stack>
    </PageFrame>
  );
};

export default StudioPage;
