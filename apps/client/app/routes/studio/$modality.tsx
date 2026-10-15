import { Stack, Tab, TabList, Tabs, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import PageFrame from '@client/app/components/common/PageFrame';
import { STUDIO_MODALITIES, isStudioModality, type StudioModality } from '@client/app/components/Studio/studioModality';
import { STUDIO_MODALITY_DEFINITIONS } from '@client/app/components/Studio/studioModalityRegistry';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

const StudioPage = ({ modality }: { modality: StudioModality }) => {
  const navigate = useNavigate();
  const { tabLabel, galleryTitle, testId, Workspace, Gallery } = STUDIO_MODALITY_DEFINITIONS[modality];
  useDocumentTitle(`${tabLabel} Studio`);

  return (
    <PageFrame testId={`${testId}-page`}>
      <Stack gap={3}>
        <Typography level="h2">Studio</Typography>
        {/* Each tab is its own URL (/studio/<modality>), so a tab can be linked to and survives a reload. */}
        <Tabs
          value={modality}
          onChange={(_event, value) => {
            if (typeof value === 'string' && isStudioModality(value) && value !== modality) {
              void navigate({ to: '/studio/$modality', params: { modality: value } });
            }
          }}
          sx={{ bgcolor: 'transparent' }}
        >
          <TabList data-testid="studio-tabs">
            {STUDIO_MODALITIES.map(candidate => (
              <Tab key={candidate} value={candidate} data-testid={`studio-tab-${candidate}`}>
                {STUDIO_MODALITY_DEFINITIONS[candidate].tabLabel}
              </Tab>
            ))}
          </TabList>
        </Tabs>
        <Workspace testId={testId} />
        <Typography level="title-lg">{galleryTitle}</Typography>
        <Gallery />
      </Stack>
    </PageFrame>
  );
};

export default StudioPage;
