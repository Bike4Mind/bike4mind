import { useEffect, useState } from 'react';
import { TabList, TabPanel, Tabs, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import PageFrame from '@client/app/components/common/PageFrame';
import { PageTab, pageTabListSx } from '@client/app/components/common/pageTabs';
import ApiTabContent from '@client/app/components/ProfileModal/ApiTabContent';
import IntegrationsGallery from '@client/app/components/integrations/IntegrationsGallery';
import { useMobileHeader } from '@client/app/hooks/useMobileHeader';
import { integrationsRoute, type ConnectionsTab } from '@client/app/router';

/** /integrations ("Connections"): the integrations gallery and the API keys, as two tabs. */
const IntegrationsPage = () => {
  useMobileHeader('Connections');
  const { source, tab } = integrationsRoute.useSearch();
  const activeTab: ConnectionsTab = tab ?? 'integrations';
  const navigate = useNavigate();
  // The entry point as first seen: the effect below strips `?source=` before the gallery may mount.
  const [entrySource] = useState(source);
  // Mounted on first visit to the Integrations tab and kept mounted after, so the page view it records
  // counts a visit that actually showed the gallery, exactly once. A has-been-active flag, adjusted
  // during render (React's pattern) so the gallery mounts in the same commit the tab becomes active.
  const [galleryMounted, setGalleryMounted] = useState(activeTab === 'integrations');
  if (!galleryMounted && activeTab === 'integrations') setGalleryMounted(true);

  // The entry point is held in state, so the param can go: dropping it keeps a reload, a bookmark or a
  // shared link from counting as another visit from that source. The tab stays, so the URL still
  // reflects what is on screen.
  useEffect(() => {
    if (source) void navigate({ to: '/integrations', search: tab ? { tab } : {}, replace: true });
  }, [source, tab, navigate]);

  return (
    <PageFrame testId="integrations-page">
      <Typography level="h2" sx={{ fontWeight: 500, fontSize: '20px' }}>
        Connections
      </Typography>
      <Tabs
        aria-label="Connections sections"
        value={activeTab}
        onChange={(_, value) =>
          void navigate({
            to: '/integrations',
            search: { tab: value === 'api-keys' ? 'api-keys' : 'integrations' },
            replace: true,
          })
        }
        sx={{ mt: '12px', backgroundColor: 'transparent' }}
      >
        <TabList sx={pageTabListSx}>
          <PageTab value="integrations" data-testid="connections-tab-integrations">
            <Typography sx={{ color: 'text.primary' }}>Integrations</Typography>
          </PageTab>
          <PageTab value="api-keys" data-testid="connections-tab-api-keys">
            <Typography sx={{ color: 'text.primary' }}>API Keys</Typography>
          </PageTab>
        </TabList>
        {/* keepMounted, but only after the first visit: the gallery records the page view on mount, so
            remounting it on every tab switch would count the visit again, and mounting it hidden
            behind API Keys would count a visit that never showed it. */}
        <TabPanel value="integrations" keepMounted sx={{ p: 0, pt: '16px' }}>
          {galleryMounted && <IntegrationsGallery source={entrySource ?? 'direct'} showHeading={false} />}
        </TabPanel>
        <TabPanel value="api-keys" sx={{ p: 0, pt: '16px' }}>
          {activeTab === 'api-keys' && <ApiTabContent replaceHistory={false} />}
        </TabPanel>
      </Tabs>
    </PageFrame>
  );
};

export default IntegrationsPage;
