import { Stack, Tab, TabList, Tabs, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import PageFrame from '@client/app/components/common/PageFrame';
import {
  STUDIO_MODALITIES,
  isStudioModality,
  isStudioV2OnlyMedium,
  type StudioMedium,
  type StudioModality,
} from '@client/app/components/Studio/studioModality';
import { STUDIO_MODALITY_DEFINITIONS } from '@client/app/components/Studio/studioModalityRegistry';
import { useStudioFeature } from '@client/app/components/Studio/useStudioFeature';
import StudioCreateV2Page from '@client/app/components/Studio/v2/StudioCreateV2Page';
import StudioFeatureGate from '@client/app/components/Studio/v2/StudioFeatureGate';
import { STUDIO_V2_ONLY_MEDIUM_FEATURE } from '@client/app/components/Studio/v2/studioCreateMedia';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

/** The Studio as it stands without Create v2: one tab per modality above that modality's form and gallery. */
const LegacyStudioPage = ({ modality }: { modality: StudioModality }) => {
  const navigate = useNavigate();
  const { tabLabel, galleryTitle, testId, Workspace, Gallery } = STUDIO_MODALITY_DEFINITIONS[modality];
  useDocumentTitle(`${tabLabel} Studio`);

  return (
    <PageFrame testId={`${testId}-page`}>
      <Stack gap={3}>
        <Typography level="h2" component="h1">
          Studio
        </Typography>
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

/**
 * /studio/<medium>. A legacy modality renders the legacy page until Create v2 opens (so it shows while the flags
 * load, as it always has); a v2-only medium waits for its flag and 404s without it.
 */
const StudioPage = ({ modality }: { modality: StudioMedium }) => {
  const isCreateV2Open = useStudioFeature('createV2');
  if (isStudioV2OnlyMedium(modality)) {
    return (
      <StudioFeatureGate feature={STUDIO_V2_ONLY_MEDIUM_FEATURE[modality]}>
        <StudioCreateV2Page medium={modality} />
      </StudioFeatureGate>
    );
  }
  return isCreateV2Open ? <StudioCreateV2Page medium={modality} /> : <LegacyStudioPage modality={modality} />;
};

export default StudioPage;
