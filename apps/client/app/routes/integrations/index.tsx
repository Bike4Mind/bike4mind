import { useEffect } from 'react';
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

  // The gallery has recorded the entry point by now (child effects run first). Dropping the param
  // keeps a reload, a bookmark or a shared link from counting as another visit from that source.
  // The tab stays, so the URL still reflects what is on screen.
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
        <TabPanel value="integrations" sx={{ p: 0, pt: '16px' }}>
          {activeTab === 'integrations' && <IntegrationsGallery source={source ?? 'direct'} showHeading={false} />}
        </TabPanel>
        <TabPanel value="api-keys" sx={{ p: 0, pt: '16px' }}>
          {activeTab === 'api-keys' && <ApiTabContent />}
        </TabPanel>
      </Tabs>
    </PageFrame>
  );
};

export default IntegrationsPage;
