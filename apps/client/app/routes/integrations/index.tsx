import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import PageFrame from '@client/app/components/common/PageFrame';
import IntegrationsGallery from '@client/app/components/integrations/IntegrationsGallery';
import { useMobileHeader } from '@client/app/hooks/useMobileHeader';
import { integrationsRoute } from '@client/app/router';

/** /integrations - every integration and model provider, in the same frame as Gears. */
const IntegrationsPage = () => {
  useMobileHeader('Integrations');
  const { source } = integrationsRoute.useSearch();
  const navigate = useNavigate();

  // The gallery has recorded the entry point by now (child effects run first). Dropping the param
  // keeps a reload, a bookmark or a shared link from counting as another visit from that source.
  useEffect(() => {
    if (source) void navigate({ to: '/integrations', search: {}, replace: true });
  }, [source, navigate]);

  return (
    <PageFrame testId="integrations-page">
      <IntegrationsGallery source={source ?? 'direct'} />
    </PageFrame>
  );
};

export default IntegrationsPage;
