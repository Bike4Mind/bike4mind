import { FC, useState } from 'react';
import { Box, Tab, TabList, TabPanel, Tabs } from '@mui/joy';
import BusinessIcon from '@mui/icons-material/Business';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import { IOrganizationDocument } from '@bike4mind/common';
import { OrgUsageDashboard } from '@client/app/components/admin/CreditAnalysis/components/OrgUsageDashboard';
import { TransactionLedger } from '@client/app/components/admin/CreditAnalysis/components/TransactionLedger';

/**
 * Org owner/manager surface for their own org's AI spend: the same Usage and
 * Ledger dashboards as the admin Credit Analytics tab, but pinned to this org
 * (picker hidden). Access is enforced server-side via verifyOrgAccess plus the
 * owner-scoped queries; this is only rendered for owner/manager/admin.
 */
const OrganizationUsageSection: FC<{ organization: IOrganizationDocument }> = ({ organization }) => {
  const [tab, setTab] = useState<'usage' | 'ledger'>('usage');

  return (
    <Tabs value={tab} onChange={(_, value) => setTab(value as 'usage' | 'ledger')}>
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
      </TabList>

      <TabPanel value="usage" sx={{ p: 0 }}>
        <OrgUsageDashboard organizationId={organization.id} />
      </TabPanel>
      <TabPanel value="ledger" sx={{ p: 0 }}>
        <TransactionLedger organizationId={organization.id} />
      </TabPanel>
    </Tabs>
  );
};

export default OrganizationUsageSection;
