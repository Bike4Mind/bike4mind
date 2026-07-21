import { IOrganizationDocument, Permission, WithId } from '@bike4mind/common';
import Breadcrumbs from '@client/app/components/common/Breadcrumbs';
import OrganizationMembers from '@client/app/components/organizations/Member';
import OrganizationBillingSection from '@client/app/components/organizations/OrganizationBillingSection';
import OrganizationSettingsSection from '@client/app/components/organizations/OrganizationSettingsSection';
import OrganizationUsageSection from '@client/app/components/organizations/OrganizationUsageSection';
import OrgSlackIntegration from '@client/app/components/organizations/OrgSlackIntegration';
import OrgWebhookConfig from '@client/app/components/organizations/OrgWebhookConfig';
import OrgGitHubConnectionTab from '@client/app/components/organizations/OrgGitHubConnectionTab';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetOrganization, useOrganizationSeats } from '@client/app/hooks/data/organizations';
import { useGetSubscriptionsByOwner } from '@client/app/hooks/data/subscriptions';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import {
  Avatar,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  LinearProgress,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Typography,
} from '@mui/joy';
import BusinessOutlinedIcon from '@mui/icons-material/BusinessOutlined';
import CreditCardOutlinedIcon from '@mui/icons-material/CreditCardOutlined';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import GitHubIcon from '@mui/icons-material/GitHub';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import { useParams, useSearch } from '@tanstack/react-router';
import { FC, useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

enum OrganizationTabs {
  Overview = 'overview',
  Members = 'members',
  Usage = 'usage',
  Billing = 'billing',
  Integrations = 'integrations',
  GitHub = 'github',
  Webhooks = 'webhooks',
  Settings = 'settings',
}

const OrganizationPage: FC = () => {
  const { t } = useTranslation();
  const { id } = useParams({ strict: false });
  const { data: organization, isLoading } = useGetOrganization(id as string);
  const { maxSeats, currentSeats } = useOrganizationSeats(id as string);
  const search = useSearch({ strict: false }) as { tab?: string };
  const [selectedTab, setSelectedTab] = useState<OrganizationTabs>(
    search.tab && Object.values(OrganizationTabs).includes(search.tab as OrganizationTabs)
      ? (search.tab as OrganizationTabs)
      : OrganizationTabs.Overview
  );
  const { currentUser } = useUser();

  // Check user permissions.
  // In the b4m client only the org owner can add/remove members.
  // Admins who are merely members of the org are treated as regular members here;
  // they can manage members via the dedicated Admin -> Organizations panel instead.
  const userPermissions = useMemo(() => {
    if (!currentUser || !organization) return [];
    if (currentUser.id === organization.userId) return [Permission.read, Permission.update, Permission.share];
    const memberDetails = organization.users.find(u => u.userId === currentUser.id);
    return memberDetails?.permissions || [];
  }, [currentUser, organization]);

  const canManageOrg = useMemo(() => {
    return userPermissions.includes(Permission.share) || userPermissions.includes(Permission.update);
  }, [userPermissions]);

  // Who may see the org's usage/spend dashboards. Mirrors the server gate
  // (verifyOrgAccess): platform admins, the org owner, or the team manager -
  // NOT every member with manage permissions, so the tab never shows to someone
  // the API would 404.
  const canViewUsage = useMemo(() => {
    if (!currentUser || !organization) return false;
    if (currentUser.isAdmin) return true;
    if (currentUser.id === organization.userId) return true;
    return organization.managerId === currentUser.id;
  }, [currentUser, organization]);

  // Redirect non-admin users if they try to access restricted tabs
  useEffect(() => {
    const managePinnedTab =
      selectedTab === OrganizationTabs.Billing ||
      selectedTab === OrganizationTabs.Integrations ||
      selectedTab === OrganizationTabs.GitHub ||
      selectedTab === OrganizationTabs.Webhooks ||
      selectedTab === OrganizationTabs.Settings;
    if (!canManageOrg && managePinnedTab) {
      setSelectedTab(OrganizationTabs.Overview);
    } else if (!canViewUsage && selectedTab === OrganizationTabs.Usage) {
      setSelectedTab(OrganizationTabs.Overview);
    }
  }, [canManageOrg, canViewUsage, selectedTab]);

  useDocumentTitle(organization?.name, ' | Organization');

  return isLoading || !organization ? (
    <Box display="flex" justifyContent="center" alignItems="center" height="100%" width="100%">
      <CircularProgress />
    </Box>
  ) : (
    <Stack
      gap="24px"
      height="100vh"
      sx={theme => ({
        backgroundColor: theme.palette.background.level1,
        pt: '24px',
        '& ::-webkit-scrollbar-thumb': {
          backgroundColor: theme.palette.background.scrollbar,
          border: `2px solid ${theme.palette.background.scrollbarTrack}`,
          borderRadius: '20px',
        },
        '& ::-webkit-scrollbar': {
          width: '8px',
        },
        '& ::-webkit-scrollbar-track': {
          backgroundColor: theme.palette.background.scrollbarTrack,
        },
      })}
    >
      <Box sx={{ mx: '24px' }}>
        <Breadcrumbs
          items={[{ name: t('organization.organizations'), href: '/organizations' }, { name: organization.name }]}
        />
      </Box>

      <OrganizationHeader
        organization={organization}
        onSettingsClick={() => canManageOrg && setSelectedTab(OrganizationTabs.Settings)}
      />

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Tabs
          orientation="vertical"
          sx={{
            borderRadius: 'sm',
            flex: 1,
            overflow: 'hidden',
            minHeight: 0,
          }}
          value={selectedTab}
          onChange={(_, value) => setSelectedTab(value as OrganizationTabs)}
        >
          <TabList
            sx={{
              width: '240px',
              borderRight: '1px solid',
              borderColor: 'divider',
              p: 2,
              '& .MuiTab-root': {
                justifyContent: 'flex-start',
                px: 2,
                py: 1.5,
                '&.Mui-selected': {
                  backgroundColor: 'background.level2',
                  fontWeight: 'bold',
                },
              },
            }}
          >
            <Tab value={OrganizationTabs.Overview} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <BusinessOutlinedIcon sx={{ fontSize: 16 }} />
              Overview
            </Tab>
            <Tab value={OrganizationTabs.Members} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <GroupOutlinedIcon sx={{ fontSize: 16 }} />
              Members
            </Tab>
            {canViewUsage && (
              <Tab value={OrganizationTabs.Usage} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <InsightsOutlinedIcon sx={{ fontSize: 16 }} />
                Usage
              </Tab>
            )}
            {canManageOrg && (
              <>
                <Tab value={OrganizationTabs.Billing} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <CreditCardOutlinedIcon sx={{ fontSize: 16 }} />
                  Billing
                </Tab>
                <Tab value={OrganizationTabs.Integrations} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <ExtensionOutlinedIcon sx={{ fontSize: 16 }} />
                  Integrations
                </Tab>
                <Tab value={OrganizationTabs.GitHub} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <VpnKeyOutlinedIcon sx={{ fontSize: 16 }} />
                  GitHub API
                </Tab>
                <Tab value={OrganizationTabs.Webhooks} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <GitHubIcon sx={{ fontSize: 16 }} />
                  Webhooks
                </Tab>
                <Tab value={OrganizationTabs.Settings} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <SettingsOutlinedIcon sx={{ fontSize: 16 }} />
                  Settings
                </Tab>
              </>
            )}
          </TabList>

          <Box sx={{ p: 3, flex: 1, overflow: 'auto' }}>
            <TabPanel value={OrganizationTabs.Overview}>
              <OrganizationOverviewSection organization={organization} />
            </TabPanel>
            <TabPanel value={OrganizationTabs.Members}>
              <Typography level="title-lg" startDecorator={<GroupOutlinedIcon />} sx={{ mb: 3 }}>
                Members ({currentSeats} / {maxSeats})
              </Typography>
              {currentUser && <OrganizationMembers organization={organization} userPermissions={userPermissions} />}
            </TabPanel>
            {canViewUsage && (
              <TabPanel value={OrganizationTabs.Usage}>
                <Typography level="title-lg" startDecorator={<InsightsOutlinedIcon />} sx={{ mb: 3 }}>
                  Usage & Spend
                </Typography>
                <OrganizationUsageSection organization={organization} />
              </TabPanel>
            )}
            {canManageOrg && (
              <>
                <TabPanel value={OrganizationTabs.Billing}>
                  <Typography level="title-lg" startDecorator={<CreditCardOutlinedIcon />} sx={{ mb: 3 }}>
                    Billing & Subscription
                  </Typography>
                  <OrganizationBillingSection organization={organization} />
                </TabPanel>
                <TabPanel value={OrganizationTabs.Integrations}>
                  <Typography level="title-lg" startDecorator={<ExtensionOutlinedIcon />} sx={{ mb: 3 }}>
                    Integrations
                  </Typography>
                  <OrgSlackIntegration organization={organization} />
                </TabPanel>
                <TabPanel value={OrganizationTabs.GitHub}>
                  <OrgGitHubConnectionTab orgId={organization.id} />
                </TabPanel>
                <TabPanel value={OrganizationTabs.Webhooks}>
                  <Typography level="title-lg" startDecorator={<GitHubIcon />} sx={{ mb: 3 }}>
                    GitHub Webhooks
                  </Typography>
                  <OrgWebhookConfig organization={organization} />
                </TabPanel>
                <TabPanel value={OrganizationTabs.Settings}>
                  <Typography level="title-lg" startDecorator={<SettingsOutlinedIcon />} sx={{ mb: 3 }}>
                    Organization Settings
                  </Typography>
                  <OrganizationSettingsSection organization={organization} />
                </TabPanel>
              </>
            )}
          </Box>
        </Tabs>
      </Box>
    </Stack>
  );
};

const OrganizationHeader: FC<{
  organization: WithId<IOrganizationDocument>;
  onSettingsClick: () => void;
}> = ({ organization, onSettingsClick }) => {
  const { name, description } = organization;
  const initial = name.charAt(0).toUpperCase();
  const { data: subscriptions } = useGetSubscriptionsByOwner(SubscriptionOwnerType.Organization, organization.id);
  const hasActiveSubscription = subscriptions?.some(sub => !sub.canceledAt);
  const { currentSeats } = useOrganizationSeats(organization.id);
  const { currentUser } = useUser();
  const canManageOrg = useMemo(() => {
    if (!currentUser || !organization) return false;
    // Grant admin permissions if user is a system admin
    if (currentUser.isAdmin) return true;
    // Grant full permissions if user is the owner
    if (currentUser.id === organization.userId) return true;
    const memberDetails = organization.users.find(u => u.userId === currentUser.id);
    return memberDetails?.permissions?.some(p => p === Permission.share || p === Permission.update) ?? false;
  }, [currentUser, organization]);

  return (
    <Card variant="outlined" sx={{ mx: 3, p: 3 }}>
      <Stack direction="row" spacing={3} alignItems="center">
        <Avatar size="lg" sx={{ '--Avatar-size': '64px' }}>
          {initial}
        </Avatar>
        <Stack spacing={1} flex={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography level="h3">{name}</Typography>
            {canManageOrg && (
              <Button
                variant="outlined"
                color="neutral"
                startDecorator={<SettingsOutlinedIcon sx={{ fontSize: 16 }} />}
                size="sm"
                onClick={onSettingsClick}
              >
                Organization Settings
              </Button>
            )}
          </Stack>
          <Typography level="body-sm" color="neutral">
            {description}
          </Typography>
          <Stack direction="row" spacing={2} mt={1}>
            <Chip size="sm" variant="soft" startDecorator={<GroupOutlinedIcon sx={{ fontSize: 14 }} />}>
              {currentSeats} Members
            </Chip>
            <Chip size="sm" variant="soft" startDecorator={<Bike4MindIcon size="14" />}>
              {organization.currentCredits.toLocaleString()} Credits
            </Chip>
            <Chip
              size="sm"
              variant="soft"
              color={hasActiveSubscription ? 'success' : 'neutral'}
              startDecorator={<VpnKeyOutlinedIcon sx={{ fontSize: 14 }} />}
            >
              {hasActiveSubscription ? 'Team Plan' : 'No Active Plan'}
            </Chip>
          </Stack>
        </Stack>
      </Stack>
    </Card>
  );
};

const OrganizationOverviewSection: FC<{ organization: IOrganizationDocument }> = ({ organization }) => {
  const { i18n } = useTranslation();
  const { currentSeats, maxSeats, pendingSeats, availableSeats } = useOrganizationSeats(organization.id);
  const { data: subscriptions } = useGetSubscriptionsByOwner(SubscriptionOwnerType.Organization, organization.id);

  const activeSubscription = subscriptions?.find(sub => !sub.canceledAt);

  // Calculate storage usage percentage
  const storageUsed = organization.currentStorageSize || 0;
  const storageLimit = organization.storageLimit || 0;
  const storagePercentage =
    storageLimit > 0 ? Math.min(100, Math.max(0, (storageUsed / (storageLimit * 1024 * 1024)) * 100)) : 0;

  // Format bytes to human-readable format
  const formatBytes = (bytes: number) => {
    if (bytes <= 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  // Format next billing date
  const formatDate = (date: Date | string | undefined) => {
    if (!date) return 'N/A';
    return new Date(date).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <Stack spacing={3}>
      <Typography level="title-lg" startDecorator={<BusinessOutlinedIcon />}>
        Organization Overview
      </Typography>

      {/* First row - Key metrics */}
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        <Card variant="outlined" sx={{ flex: 1, minWidth: 200, p: 3 }}>
          <Stack spacing={1}>
            <Typography level="body-xs" color="neutral">
              Total Members
            </Typography>
            <Typography level="h2">{currentSeats}</Typography>
          </Stack>
        </Card>
        <Card variant="outlined" sx={{ flex: 1, minWidth: 200, p: 3 }}>
          <Stack spacing={1}>
            <Typography level="body-xs" color="neutral" startDecorator={<Bike4MindIcon size="14" />}>
              Available Credits
            </Typography>
            <Typography level="h2">{organization.currentCredits.toLocaleString()}</Typography>
          </Stack>
        </Card>
      </Stack>

      {/* Second row - Detailed cards */}
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        {/* Storage Usage Card */}
        <Card variant="outlined" sx={{ flex: 1, minWidth: 280, p: 3 }} data-testid="storage-usage-card">
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography level="title-md" startDecorator={<StorageOutlinedIcon sx={{ fontSize: 20 }} />}>
                Storage Usage
              </Typography>
              <Typography level="body-sm" color="neutral">
                {storagePercentage.toFixed(1)}%
              </Typography>
            </Stack>
            <LinearProgress
              determinate
              value={Math.min(storagePercentage, 100)}
              color={storagePercentage > 90 ? 'danger' : storagePercentage > 70 ? 'warning' : 'primary'}
              sx={{ '--LinearProgress-thickness': '8px' }}
              aria-label={`Storage usage: ${storagePercentage.toFixed(1)}%`}
            />
            <Stack direction="row" justifyContent="space-between">
              <Typography level="body-sm" color="neutral">
                {formatBytes(storageUsed)} used
              </Typography>
              <Typography level="body-sm" color="neutral">
                {storageLimit > 0 ? `${storageLimit} MB limit` : 'No limit'}
              </Typography>
            </Stack>
          </Stack>
        </Card>

        {/* Subscription Status Card */}
        <Card variant="outlined" sx={{ flex: 1, minWidth: 280, p: 3 }} data-testid="subscription-status-card">
          <Stack spacing={2}>
            <Typography level="title-md" startDecorator={<VpnKeyOutlinedIcon sx={{ fontSize: 20 }} />}>
              Subscription Status
            </Typography>
            <Stack spacing={1}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography level="body-sm" color="neutral">
                  Plan
                </Typography>
                <Chip size="sm" variant="soft" color={activeSubscription ? 'success' : 'neutral'}>
                  {activeSubscription ? 'Team Plan' : 'No Active Plan'}
                </Chip>
              </Stack>
              {activeSubscription && (
                <>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography level="body-sm" color="neutral">
                      Status
                    </Typography>
                    <Typography level="body-sm">{activeSubscription.canceledAt ? 'Canceling' : 'Active'}</Typography>
                  </Stack>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography level="body-sm" color="neutral">
                      <EventAvailableOutlinedIcon sx={{ fontSize: 14, mr: 0.5, verticalAlign: 'text-bottom' }} />
                      Next Billing
                    </Typography>
                    <Typography level="body-sm">{formatDate(activeSubscription.periodEndsAt)}</Typography>
                  </Stack>
                </>
              )}
            </Stack>
          </Stack>
        </Card>

        {/* Seats Utilization Card */}
        <Card variant="outlined" sx={{ flex: 1, minWidth: 280, p: 3 }} data-testid="seats-utilization-card">
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography level="title-md" startDecorator={<GroupOutlinedIcon sx={{ fontSize: 20 }} />}>
                Seats Utilization
              </Typography>
              <Typography level="body-sm" color="neutral">
                {currentSeats} / {maxSeats}
              </Typography>
            </Stack>
            <LinearProgress
              determinate
              value={maxSeats > 0 ? (currentSeats / maxSeats) * 100 : 0}
              color={currentSeats >= maxSeats ? 'danger' : currentSeats > maxSeats * 0.8 ? 'warning' : 'primary'}
              sx={{ '--LinearProgress-thickness': '8px' }}
              aria-label={`Seats utilization: ${currentSeats} of ${maxSeats} seats used`}
            />
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip size="sm" variant="soft" color="primary">
                {currentSeats - pendingSeats} Active
              </Chip>
              {pendingSeats > 0 && (
                <Chip size="sm" variant="soft" color="warning">
                  {pendingSeats} Pending
                </Chip>
              )}
              <Chip size="sm" variant="soft" color="neutral">
                {availableSeats} Available
              </Chip>
            </Stack>
          </Stack>
        </Card>
      </Stack>
    </Stack>
  );
};

export default OrganizationPage;
