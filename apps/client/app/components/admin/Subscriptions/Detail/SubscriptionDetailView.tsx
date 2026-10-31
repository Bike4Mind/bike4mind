import React, { useState } from 'react';
import { Box, Link, Stack, Typography } from '@mui/joy';
import type { AdminSubscriptionDetail } from '@client/app/utils/adminSubscriptionDetail';
import { SubscriptionDetailHeader } from './SubscriptionDetailHeader';
import { SubscriptionDetailStats } from './SubscriptionDetailStats';
import { SubscriptionDetailTabs, subscriptionDetailPanelId, subscriptionDetailTabId } from './SubscriptionDetailTabs';
import { OverviewTab } from './tabs/OverviewTab';
import { SubscriptionAdminLogTab } from './tabs/SubscriptionAdminLogTab';
import { ExtendCompDialog } from './actions/ExtendCompDialog';
import { EndCompDialog } from './actions/EndCompDialog';
import { EditCreditsPerCycleDialog } from './actions/EditCreditsPerCycleDialog';
import { RemoveSubscriptionDialog } from './actions/RemoveSubscriptionDialog';
import type { SubscriptionDetailTab } from './subscriptionDetailSearch';
import { ownerDisplayName, type SubscriptionAction } from './subscriptionDetailModel';
import type { SubscriptionNavigation } from './useSubscriptionNavigation';

type SubscriptionDetailViewProps = {
  detail: AdminSubscriptionDetail;
  tab: SubscriptionDetailTab;
  onTabChange: (tab: SubscriptionDetailTab) => void;
  navigation: SubscriptionNavigation;
};

const Breadcrumb: React.FC<{ name: string; onBack: () => void }> = ({ name, onBack }) => (
  <Stack
    component="nav"
    aria-label="Breadcrumb"
    direction="row"
    alignItems="center"
    gap={1}
    flexWrap="wrap"
    sx={{ fontSize: 13 }}
  >
    <Link
      component="button"
      type="button"
      onClick={onBack}
      sx={{ fontSize: 13 }}
      data-testid="subscription-detail-back-btn"
    >
      Subscriptions
    </Link>
    <Typography level="body-sm" aria-hidden sx={{ color: 'admin.inkMuted' }}>
      /
    </Typography>
    <Typography level="body-sm" aria-current="page" sx={{ color: 'admin.inkMuted', overflowWrap: 'anywhere' }}>
      {name}
    </Typography>
  </Stack>
);

/** One subscription: every write is a named action that opens its own dialog. */
export const SubscriptionDetailView: React.FC<SubscriptionDetailViewProps> = ({
  detail,
  tab,
  onTabChange,
  navigation,
}) => {
  const [action, setAction] = useState<SubscriptionAction | null>(null);
  const closeAction = () => setAction(null);
  const openAdminLog = () => onTabChange('admin');

  const dialog = () => {
    switch (action) {
      case null:
        return null;
      case 'extend':
        return <ExtendCompDialog detail={detail} onClose={closeAction} onAudit={openAdminLog} />;
      case 'end':
        return <EndCompDialog detail={detail} onClose={closeAction} onAudit={openAdminLog} />;
      case 'credits':
        return <EditCreditsPerCycleDialog detail={detail} onClose={closeAction} onAudit={openAdminLog} />;
      case 'remove':
        return (
          <RemoveSubscriptionDialog
            detail={detail}
            onClose={closeAction}
            onRemoved={() => void navigation.backToList()}
          />
        );
    }
  };

  const panel = () => {
    switch (tab) {
      case 'overview':
        return (
          <OverviewTab
            detail={detail}
            onOpenOwner={link => void navigation.openOwner(link)}
            onOpenSubscription={id => void navigation.openSubscription(id)}
            onOpenLedger={userId => void navigation.openUserLedger(userId)}
          />
        );
      case 'admin':
        return <SubscriptionAdminLogTab subscriptionId={detail.subscription.id} />;
    }
  };

  return (
    <Stack gap={2.5} data-testid="subscription-detail-view">
      <Breadcrumb name={ownerDisplayName(detail.subscription)} onBack={() => void navigation.backToList()} />
      <SubscriptionDetailHeader
        detail={detail}
        onAction={setAction}
        onOpenOwner={link => void navigation.openOwner(link)}
      />
      <SubscriptionDetailStats detail={detail} />
      <Box>
        <SubscriptionDetailTabs value={tab} onChange={onTabChange} />
        <Box
          role="tabpanel"
          id={subscriptionDetailPanelId(tab)}
          aria-labelledby={subscriptionDetailTabId(tab)}
          sx={{ pt: 2.5 }}
          data-testid={`subscription-detail-panel-${tab}`}
        >
          {panel()}
        </Box>
      </Box>
      {dialog()}
    </Stack>
  );
};
