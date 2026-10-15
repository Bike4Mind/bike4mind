import PageFrame from '@client/app/components/common/PageFrame';
import IntegrationsGallery from '@client/app/components/integrations/IntegrationsGallery';
import { useMobileHeader } from '@client/app/hooks/useMobileHeader';

/** /integrations - every integration and model provider, in the same frame as Gears. */
const IntegrationsPage = () => {
  useMobileHeader('Integrations');
  return (
    <PageFrame testId="integrations-page">
      <IntegrationsGallery />
    </PageFrame>
  );
};

export default IntegrationsPage;
