import { FC, useState } from 'react';
import { Box, Tab, TabList, TabPanel, Tabs } from '@mui/joy';
import BusinessIcon from '@mui/icons-material/Business';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import StorageIcon from '@mui/icons-material/Storage';
import { CreditHolderType, IOrganizationDocument } from '@bike4mind/common';
import { UsageDashboard } from '@client/app/components/admin/CreditAnalysis/components/UsageDashboard';
import { TransactionLedger } from '@client/app/components/admin/CreditAnalysis/components/TransactionLedger';
import OrganizationStorageUsage from './OrganizationStorageUsage';

type UsageTab = 'usage' | 'ledger' | 'storage';

/**
 * Org owner/manager surface for their own org's AI spend: the same Usage and
 * Ledger dashboards as the admin Credit Analytics tab, but pinned to this org
 * (picker hidden), plus the org's storage pool. Access is enforced server-side via verifyOrgAccess plus the
 * owner-scoped queries; this is only rendered for owner/manager/admin.
 */
const OrganizationUsageSection: FC<{ organization: IOrganizationDocument }> = ({ organization }) => {
  const [tab, setTab] = useState<UsageTab>('usage');

  return (
    <Tabs value={tab} onChange={(_, value) => setTab(value as UsageTab)}>
      <TabList sx={{ mb: 2 }}>
        <Tab value="usage" data-testid="org-usage-tab">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <BusinessIcon sx={{ fontSize: '18px' }} />
            Usage
          </Box>
        </Tab>
        <Tab value="ledger" data-testid="org-ledger-tab">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ReceiptLongIcon sx={{ fontSize: '18px' }} />
            Ledger
          </Box>
        </Tab>
        <Tab value="storage" data-testid="org-storage-tab">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <StorageIcon sx={{ fontSize: '18px' }} />
            Storage
          </Box>
        </Tab>
      </TabList>

      <TabPanel value="usage" sx={{ p: 0 }}>
        <UsageDashboard ownerType={CreditHolderType.Organization} ownerId={organization.id} />
      </TabPanel>
      <TabPanel value="ledger" sx={{ p: 0 }}>
        <TransactionLedger organizationId={organization.id} />
      </TabPanel>
      <TabPanel value="storage" sx={{ p: 0 }}>
        <OrganizationStorageUsage organizationId={organization.id} />
      </TabPanel>
    </Tabs>
  );
};

export default OrganizationUsageSection;
