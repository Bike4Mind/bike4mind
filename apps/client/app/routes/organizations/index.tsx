import { IOrganizationDocument } from '@bike4mind/common';
import { useCreateTeamModal } from '@client/app/components/organizations/CreateTeamModal';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetUserOrganizations, useOrganizationSeats } from '@client/app/hooks/data/organizations';
import { useGetSubscriptionsByOwner } from '@client/app/hooks/data/subscriptions';
import { useTeamPlanAvailable } from '@client/app/hooks/data/teamPlanSettings';
import { TEAM_PLAN_UNAVAILABLE_MESSAGE } from '@bike4mind/server-utils/lib/subscriptions/constants';
import {
  SubscriptionOwnerType,
  isDelinquentSubscriptionStatus,
  pickDisplayedSubscription,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import AddIcon from '@mui/icons-material/Add';
import BusinessIcon from '@mui/icons-material/Business';
import SearchIcon from '@mui/icons-material/Search';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import {
  AspectRatio,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Grid,
  Input,
  LinearProgress,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { FC, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ContextHelpButton } from '@client/app/components/help';
import { getAppFileUrl } from '@client/app/utils/s3';

const OrganizationCard: FC<{ organization: IOrganizationDocument }> = ({ organization }) => {
  const { t } = useTranslation();
  const { currentUser } = useUser();
  const navigate = useNavigate();
  const { data: subscriptions } = useGetSubscriptionsByOwner(SubscriptionOwnerType.Organization, organization.id);
  // The read now returns non-terminal rows, so a dunning org arrives here instead of as an empty
  // list. Pick the displayed row the same way the billing screen does, and call a delinquent one
  // what it is - a green "Active Subscription" while entitlements deny access is a false green.
  const subscription = pickDisplayedSubscription(subscriptions ?? []);
  const paymentIssue = !!subscription && isDelinquentSubscriptionStatus(subscription.status);
  const hasActiveSubscription = !!subscription && !subscription.canceledAt && !paymentIssue;
  const { currentSeats } = useOrganizationSeats(organization.id);

  const isOwner = organization.userId === currentUser?.id;
  const isManager = !!currentUser && (organization.adminUserIds ?? []).includes(currentUser.id) && !isOwner;

  return (
    <Card
      variant="outlined"
      data-testid="organization-card"
      data-org-id={organization.id}
      sx={{ height: '100%', borderColor: isOwner ? 'primary.solidBg' : undefined }}
    >
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <AspectRatio ratio="1" sx={{ width: 48, borderRadius: 'sm' }}>
            {organization.logo ? (
              <img src={getAppFileUrl({ key: organization.logo.path })} alt={organization.name} />
            ) : (
              <BusinessIcon sx={{ fontSize: 24, color: isOwner ? 'primary.solidBg' : undefined }} />
            )}
          </AspectRatio>
          <Box sx={{ flex: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography level="title-md">{organization.name}</Typography>
              {isOwner && (
                <Chip size="sm" variant="solid" color="primary">
                  {t('organization.owner')}
                </Chip>
              )}
              {isManager && (
                <Chip size="sm" variant="soft" color="primary">
                  Manager
                </Chip>
              )}
            </Box>
            <Typography level="body-sm" color="neutral">
              {organization.personal ? 'Personal team' : 'Shared team'}
            </Typography>
          </Box>
        </Box>

        {organization.description && (
          <Typography level="body-sm" mb={2}>
            {organization.description}
          </Typography>
        )}

        <Stack direction="row" spacing={1} mb={2} flexWrap="wrap" useFlexGap>
          <Chip size="sm" variant="soft" color={organization.personal ? 'neutral' : 'primary'}>
            {t('organization.x_seats', { count: organization.seats })}
          </Chip>
          <Chip size="sm" variant="soft" color="neutral">
            {t('organization.x_members', { count: currentSeats })}
          </Chip>
          <Chip size="sm" variant="soft" color="neutral">
            {t('organization.x_credits', { count: organization.currentCredits })}
          </Chip>
          {organization.billingContact && (
            <Chip size="sm" variant="soft">
              {organization.billingContact}
            </Chip>
          )}
          <Chip
            size="sm"
            variant="soft"
            color={paymentIssue ? 'danger' : hasActiveSubscription ? 'success' : 'warning'}
          >
            {paymentIssue
              ? t('organization.payment_issue')
              : hasActiveSubscription
                ? t('organization.active_subscription')
                : t('organization.no_subscription')}
          </Chip>
        </Stack>

        <Button
          variant="outlined"
          color="neutral"
          size="sm"
          fullWidth
          onClick={() => navigate({ to: `/organizations/${organization.id}` })}
          data-testid="organization-card-view-btn"
        >
          {t('organization.view_details')}
        </Button>
      </CardContent>
    </Card>
  );
};

const OrganizationCardSkeleton: FC = () => (
  <Card variant="outlined" sx={{ height: '100%' }}>
    <CardContent>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <AspectRatio ratio="1" sx={{ width: 48, borderRadius: 'sm', bgcolor: 'neutral.softBg' }}>
          <Skeleton variant="rectangular" />
        </AspectRatio>
        <Box sx={{ flex: 1 }}>
          <Skeleton variant="text" width="80%" height={24} />
          <Skeleton variant="text" width="60%" height={20} />
        </Box>
      </Box>

      <Skeleton variant="text" width="90%" height={20} sx={{ mb: 2 }} />

      <Stack direction="row" spacing={1} mb={2}>
        <Box sx={{ bgcolor: 'neutral.softBg', borderRadius: 'sm', p: 0.5, width: 80 }}>
          <Skeleton variant="rectangular" height={16} />
        </Box>
        <Box sx={{ bgcolor: 'neutral.softBg', borderRadius: 'sm', p: 0.5, width: 100 }}>
          <Skeleton variant="rectangular" height={16} />
        </Box>
      </Stack>

      <Box sx={{ bgcolor: 'neutral.softBg', borderRadius: 'sm', p: 1 }}>
        <Skeleton variant="rectangular" width="100%" height={24} />
      </Box>
    </CardContent>
  </Card>
);

const OrganizationListPage: FC = () => {
  const { t } = useTranslation();
  const { currentUser } = useUser();
  const {
    data: memberOrganizations,
    isLoading: membersLoading,
    isFetching: membersFetching,
  } = useGetUserOrganizations(currentUser?.id);
  const [searchQuery, setSearchQuery] = useState('');
  const openCreateTeamModal = useCreateTeamModal(state => state.open);
  const teamPlanAvailable = useTeamPlanAvailable();

  useDocumentTitle('Teams');

  const organizations = [...(memberOrganizations ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const isLoading = membersLoading;
  const isFetching = membersFetching;
  const filteredOrganizations = organizations.filter(
    org =>
      org.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      org.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <Box sx={{ p: 4, maxWidth: '1200px', margin: '0 auto' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography level="h2">{t('organization.organizations')}</Typography>
          <ContextHelpButton helpId="features/organizations-teams" tooltipText="Learn about Teams" />
        </Box>
        <Tooltip title={teamPlanAvailable ? undefined : TEAM_PLAN_UNAVAILABLE_MESSAGE} placement="bottom">
          {/* Span so the tooltip still fires on hover/focus while the button is disabled. */}
          <span tabIndex={teamPlanAvailable ? undefined : 0}>
            <Button
              startDecorator={<AddIcon />}
              color="primary"
              onClick={openCreateTeamModal}
              disabled={!teamPlanAvailable}
              data-testid="organizations-create-team-btn"
            >
              {t('organization.create')}
            </Button>
          </span>
        </Tooltip>
      </Box>

      <Card variant="soft" sx={{ mb: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
          <Box sx={{ flex: 1 }}>
            <Typography level="title-md">Explore Team administration before subscribing</Typography>
            <Typography level="body-sm">
              See sample members, monthly credit limits and usage, plus which controls each role can access.
            </Typography>
          </Box>
          <Button
            component="a"
            href="https://docs.bike4mind.com/features/team-admin-preview"
            target="_blank"
            rel="noopener noreferrer"
            variant="outlined"
            data-testid="organizations-admin-preview-link"
          >
            Preview Team administration
          </Button>
        </Stack>
      </Card>

      <Box sx={{ position: 'relative', mb: 4 }}>
        <Input
          startDecorator={<SearchIcon />}
          placeholder={t('organization.search')}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          slotProps={{ input: { 'data-testid': 'organizations-search-input' } }}
          sx={{ width: '100%', maxWidth: '400px' }}
        />
      </Box>

      {isFetching && !isLoading && (
        <Box sx={{ mb: 2 }}>
          <LinearProgress />
        </Box>
      )}

      <Grid container spacing={2}>
        {isLoading ? (
          <>
            {[...Array(6)].map((_, index) => (
              <Grid key={`skeleton-${index}`} xs={12} sm={6} md={4}>
                <OrganizationCardSkeleton />
              </Grid>
            ))}
          </>
        ) : (
          <>
            {filteredOrganizations.map(org => (
              <Grid key={org.id} xs={12} sm={6} md={4}>
                <OrganizationCard organization={org} />
              </Grid>
            ))}
          </>
        )}
      </Grid>

      {!isLoading && filteredOrganizations.length === 0 && (
        <Box sx={{ textAlign: 'center', py: 8 }} data-testid="organizations-empty-state">
          <Typography level="body-lg" color="neutral">
            {t('organization.no_organizations')}
          </Typography>
        </Box>
      )}
    </Box>
  );
};

export default OrganizationListPage;
