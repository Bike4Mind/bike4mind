import type { ReactNode } from 'react';
import { Stack, Tab, TabList, Tabs, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import PageFrame from '@client/app/components/common/PageFrame';
import { useStudioFeature } from '../useStudioFeature';

export type StudioArea = 'create' | 'productions' | 'library';

type StudioV2FrameProps = {
  area: StudioArea;
  testId: string;
  children: ReactNode;
};

/** The Create v2 page: the Studio heading, the Create / Productions / Library switcher, and the area below it. */
const StudioV2Frame = ({ area, testId, children }: StudioV2FrameProps) => {
  const navigate = useNavigate();
  const isImageOpen = useStudioFeature('image');
  const isProductionsOpen = useStudioFeature('productions');

  const goTo = (target: StudioArea) => {
    if (target === area) return;
    if (target === 'create') {
      void navigate({ to: '/studio/$modality', params: { modality: isImageOpen ? 'image' : 'video' } });
      return;
    }
    void navigate({ to: target === 'productions' ? '/studio/productions' : '/studio/library' });
  };

  return (
    <PageFrame testId={testId}>
      <Stack gap={3}>
        <Typography level="h2" component="h1">
          Studio
        </Typography>
        <Tabs
          value={area}
          onChange={(_event, value) => {
            if (value === 'create' || value === 'productions' || value === 'library') goTo(value);
          }}
          sx={{ bgcolor: 'transparent' }}
        >
          <TabList data-testid="studio-area-tabs">
            <Tab value="create" data-testid="studio-area-create">
              Create
            </Tab>
            {isProductionsOpen && (
              <Tab value="productions" data-testid="studio-area-productions">
                Productions
              </Tab>
            )}
            <Tab value="library" data-testid="studio-area-library">
              Library
            </Tab>
          </TabList>
        </Tabs>
        {children}
      </Stack>
    </PageFrame>
  );
};

export default StudioV2Frame;
