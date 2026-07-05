import { useGetAllSubscriptions, useGetSubscriptionStats } from '@client/app/hooks/data/subscriptions';
import { useGetSubscriptionPlans } from '@client/app/hooks/data/stripe';
import type Stripe from 'stripe';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { Sheet, Stack, LinearProgress, Typography, Box } from '@mui/joy';
import { useMemo, useState } from 'react';
import { SUBSCRIPTION_PLANS_MAP } from '@client/lib/userSubscriptions/constants';

import SubscriptionStatsCards from './components/SubscriptionStatsCards';
import SubscriptionFilters from './components/SubscriptionFilters';
import SubscriptionTable from './components/SubscriptionTable';
import PaginationControls from './components/PaginationControls';
import { SubscriptionListResponse, PlanInfo } from './types';

const AdminSubscriptions = () => {
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [status, setStatus] = useState('all');
  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('');

  const subscriptions = useGetAllSubscriptions({
    search: debouncedSearch,
    page: 1,
    limit: 100,
  });
  const plans = useGetSubscriptionPlans();
  const stats = useGetSubscriptionStats();
  const planMap = useMemo(() => {
    if (!plans.data) return {};

    return plans.data.reduce((acc: Record<string, PlanInfo>, plan: Stripe.Price) => {
      const availablePlan = SUBSCRIPTION_PLANS_MAP[plan.id];
      if (availablePlan) {
        acc[plan.id] = {
          name: availablePlan.name,
          amount: plan.unit_amount ? plan.unit_amount / 100 : 0,
          interval: availablePlan.interval,
        };
      }
      return acc;
    }, {});
  }, [plans.data]);

  const subscriptionData: SubscriptionListResponse = useMemo(() => {
    if (!subscriptions.data) {
      return {
        subscriptions: [],
        pagination: {
          total: 0,
          page: 1,
          limit: rowsPerPage,
          totalPages: 1,
        },
      };
    }

    const filteredSubscriptions =
      status === 'all'
        ? subscriptions.data.subscriptions || []
        : (subscriptions.data.subscriptions || []).filter(sub => sub.status === status);

    const startIndex = (page - 1) * rowsPerPage;
    const endIndex = startIndex + rowsPerPage;
    const paginatedSubscriptions = filteredSubscriptions.slice(startIndex, endIndex);

    return {
      subscriptions: paginatedSubscriptions,
      pagination: {
        total: filteredSubscriptions.length,
        page: page,
        limit: rowsPerPage,
        totalPages: Math.ceil(filteredSubscriptions.length / rowsPerPage),
      },
    };
  }, [subscriptions.data, rowsPerPage, status, page]);

  const handleRefresh = () => {
    subscriptions.refetch();
    stats.refetch();
    plans.refetch();
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  const handleItemsPerPageChange = (newItemsPerPage: number) => {
    setRowsPerPage(newItemsPerPage);
    setPage(1);
  };

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    setPage(1);
  };

  return (
    <Sheet sx={{ px: 2, py: 1 }}>
      <Stack spacing={1}>
        <SubscriptionFilters
          search={search}
          onSearchChange={setSearch}
          onRefresh={handleRefresh}
          isLoading={subscriptions.isPending || plans.isPending}
          status={status}
          onStatusChange={handleStatusChange}
        />

        <SubscriptionStatsCards
          stats={stats.data || { total: 0, active: 0, expiringThisMonth: 0, canceled: 0 }}
          isLoading={stats.isPending}
        />

        <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
          <PaginationControls
            currentPage={page}
            totalPages={subscriptionData.pagination.totalPages}
            itemsPerPage={rowsPerPage}
            totalItems={subscriptionData.pagination.total}
            onPageChange={handlePageChange}
            onItemsPerPageChange={handleItemsPerPageChange}
          />
        </Box>

        {(subscriptions.isPending || plans.isPending) && <LinearProgress />}

        <SubscriptionTable
          subscriptions={subscriptionData.subscriptions}
          planMap={planMap}
          isLoading={subscriptions.isPending}
        />

        {subscriptionData.subscriptions.length === 0 && !subscriptions.isPending && (
          <Typography level="body-lg" textAlign="center" sx={{ my: 4 }}>
            No subscriptions found
          </Typography>
        )}

        <PaginationControls
          currentPage={page}
          totalPages={subscriptionData.pagination.totalPages}
          itemsPerPage={rowsPerPage}
          totalItems={subscriptionData.pagination.total}
          onPageChange={handlePageChange}
          onItemsPerPageChange={handleItemsPerPageChange}
        />
      </Stack>
    </Sheet>
  );
};

export default AdminSubscriptions;
