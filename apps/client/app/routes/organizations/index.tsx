import { IOrganizationDocument } from '@bike4mind/common';
import { useCreateTeamModal } from '@client/app/components/organizations/CreateTeamModal';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetUserOrganizations, useOrganizationSeats } from '@client/app/hooks/data/organizations';
import { useGetSubscriptionsByOwner } from '@client/app/hooks/data/subscriptions';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { Add as AddIcon, Business as BusinessIcon, Search as SearchIcon } from '@mui/icons-material';
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
  const hasActiveSubscription = subscriptions?.some(sub => !sub.canceledAt);
  const { currentSeats } = useOrganizationSeats(organization.id);

  const isOwner = organization.userId === currentUser?.id;

  return (
    <Card variant="outlined" sx={{ height: '100%', borderColor: isOwner ? 'primary.solidBg' : undefined }}>
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
            </Box>
            <Typography level="body-sm" color="neutral">
              {organization.personal ? 'Personal Organization' : 'Team Organization'}
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
          <Chip size="sm" variant="soft" color={hasActiveSubscription ? 'success' : 'warning'}>
            {hasActiveSubscription ? t('organization.active_subscription') : t('organization.no_subscription')}
          </Chip>
        </Stack>

        <Button
          variant="outlined"
          color="neutral"
          size="sm"
          fullWidth
          onClick={() => navigate({ to: `/organizations/${organization.id}` })}
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
  const { data: organizations, isLoading, isFetching } = useGetUserOrganizations(currentUser?.id);
  const [searchQuery, setSearchQuery] = useState('');
  const openCreateTeamModal = useCreateTeamModal(state => state.open);

  useDocumentTitle('Organizations');

  const filteredOrganizations = organizations?.filter(
    org =>
      org.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      org.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <Box sx={{ p: 4, maxWidth: '1200px', margin: '0 auto' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography level="h2">{t('organization.organizations')}</Typography>
          <ContextHelpButton helpId="features/organizations-teams" tooltipText="Learn about Organizations" />
        </Box>
        <Button startDecorator={<AddIcon />} color="primary" onClick={openCreateTeamModal}>
          {t('organization.create')}
        </Button>
      </Box>

      <Box sx={{ position: 'relative', mb: 4 }}>
        <Input
          startDecorator={<SearchIcon />}
          placeholder={t('organization.search')}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
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
            {filteredOrganizations?.map(org => (
              <Grid key={org.id} xs={12} sm={6} md={4}>
                <OrganizationCard organization={org} />
              </Grid>
            ))}
          </>
        )}
      </Grid>

      {!isLoading && filteredOrganizations?.length === 0 && (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography level="body-lg" color="neutral">
            {t('organization.no_organizations')}
          </Typography>
        </Box>
      )}
    </Box>
  );
};

export default OrganizationListPage;
