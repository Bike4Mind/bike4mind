/**
 * Wrapper for user webhook subscriptions and delivery history, shown in the
 * Integrations tab of profile settings.
 */

import { FC, useState } from 'react';
import { Box, Typography, Modal, ModalDialog, ModalClose } from '@mui/joy';
import WebhookSubscriptions from '@client/app/components/settings/WebhookSubscriptions';
import WebhookDeliveryHistory from '@client/app/components/settings/WebhookDeliveryHistory';
import { useGetWebhookSubscriptions } from '@client/app/hooks/data/useWebhookSubscriptions';

const WebhookSubscriptionSection: FC = () => {
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState<string | null>(null);
  const { data: subscriptions } = useGetWebhookSubscriptions();

  // Find the subscription name for the modal title
  const selectedSubscription = subscriptions?.find(s => s.id === selectedSubscriptionId);

  return (
    <Box>
      <Typography level="title-md" sx={{ mb: 2 }}>
        GitHub Webhook Subscriptions
      </Typography>
      <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
        Subscribe to receive GitHub webhook events from your organizations. Events are delivered to your connected MCP
        servers.
      </Typography>

      <WebhookSubscriptions onViewHistory={setSelectedSubscriptionId} />

      {/* Delivery History Modal */}
      <Modal open={!!selectedSubscriptionId} onClose={() => setSelectedSubscriptionId(null)}>
        <ModalDialog sx={{ maxWidth: 800, width: '90vw', maxHeight: '80vh', overflow: 'auto' }}>
          <ModalClose />
          {selectedSubscriptionId && (
            <WebhookDeliveryHistory
              subscriptionId={selectedSubscriptionId}
              organizationName={selectedSubscription?.organizationName}
              onClose={() => setSelectedSubscriptionId(null)}
            />
          )}
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default WebhookSubscriptionSection;
