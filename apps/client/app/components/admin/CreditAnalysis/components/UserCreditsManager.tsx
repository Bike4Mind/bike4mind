import React, { useState } from 'react';
import {
  Box,
  Typography,
  Table,
  Sheet,
  Alert,
  Stack,
  FormControl,
  FormLabel,
  Input,
  Chip,
  Snackbar,
  Card,
  Select,
  Option,
  Button,
  LinearProgress,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import SortIcon from '@mui/icons-material/Sort';
import CreditCardIcon from '@mui/icons-material/CreditCard';
import SharedPaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useUserCreditsManager } from '../hooks/useUserCreditsManager';
import ViewUserProfile from './ViewUserProfile';
import { CreditAdjustmentModal } from './CreditAdjustmentModal';

interface AdminUser {
  id: string;
  name?: string;
  email?: string;
  currentCredits?: number;
  loginRecords?: Array<{ loginTime?: string | Date }> | null;
  lastActiveAt?: string | Date;
  isOnline?: boolean;
  isAdmin?: boolean;
  createdAt: string;
}

interface UserCreditsManagerProps {
  onRefresh?: () => void;
}

// A user with no websocket activity within this window is shown as Inactive.
const ACTIVE_WITHIN_DAYS = 30;

// Most recent explicit login (loginRecords, as the Admin > Users view uses); falls back
// to the websocket-tracked lastActiveAt for users with no recorded login yet.
const getLastLoginDate = (user: AdminUser): Date | null => {
  const latest = user.loginRecords?.reduce<string | Date | undefined>((acc, record) => {
    const t = record?.loginTime;
    if (!t) return acc;
    return !acc || new Date(t) > new Date(acc) ? t : acc;
  }, undefined);
  const source = latest ?? user.lastActiveAt;
  return source ? new Date(source) : null;
};

const getActivityStatus = (user: AdminUser): { label: string; color: 'success' | 'neutral' } => {
  if (user.isOnline) return { label: 'Online', color: 'success' };
  if (user.lastActiveAt) {
    const daysSince = (Date.now() - new Date(user.lastActiveAt).getTime()) / 86_400_000;
    if (daysSince <= ACTIVE_WITHIN_DAYS) return { label: 'Active', color: 'success' };
  }
  return { label: 'Inactive', color: 'neutral' };
};

export const UserCreditsManager: React.FC<UserCreditsManagerProps> = ({ onRefresh }) => {
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [creditsModalOpen, setCreditsModalOpen] = useState(false);
  const isMobile = useIsMobile();

  const openCreditsModal = (user: AdminUser) => {
    setSelectedUser(user);
    setCreditsModalOpen(true);
  };

  const {
    searchQuery,
    setSearchQuery,
    sortDirection,
    setSortDirection,
    pageSize,
    setPageSize,
    currentPage,
    setCurrentPage,
    totalPages,
    totalUsers,
    notification,
    setNotification,
    filteredAndSortedUsers,
    paginatedUsers,
    handleRefresh,
    handleCreditAdjustment,
    isLoading,
    error,
  } = useUserCreditsManager(onRefresh);

  return (
    <Box sx={{ height: '100%', p: 0.5 }}>
      <Card variant="outlined" sx={{ mb: 1, px: 2, py: 1 }}>
        <Stack spacing={1}>
          {/* Search - always full width */}
          <FormControl>
            <FormLabel sx={{ fontSize: 'sm', display: { xs: 'none', sm: 'block' } }}>Search users</FormLabel>
            <Input
              placeholder="Search by name or email..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              size="sm"
            />
          </FormControl>

          {/* Sort + Refresh - row on all viewports */}
          <Stack direction="row" spacing={1} alignItems="center">
            <FormControl sx={{ flex: 1 }}>
              <FormLabel sx={{ fontSize: 'sm', display: { xs: 'none', sm: 'block' } }}>Sort by Credits</FormLabel>
              <Select
                placeholder="Sort by credits"
                startDecorator={<SortIcon />}
                value={sortDirection}
                onChange={(_, value) => value && setSortDirection(value)}
                size="sm"
              >
                <Option value="desc">Highest First</Option>
                <Option value="asc">Lowest First</Option>
              </Select>
            </FormControl>
            <Button
              size="sm"
              startDecorator={<RefreshIcon />}
              onClick={handleRefresh}
              sx={{ alignSelf: { xs: 'flex-end', sm: 'center' }, flexShrink: 0 }}
            >
              Refresh
            </Button>
          </Stack>
        </Stack>
      </Card>

      <SharedPaginationControls
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={setCurrentPage}
        itemsPerPage={pageSize}
        onItemsPerPageChange={size => {
          setPageSize(size);
          setCurrentPage(1);
        }}
        totalItems={totalUsers}
        pageLimitOptions={[10, 20, 50, 100]}
      />

      {isLoading ? (
        <LinearProgress />
      ) : error ? (
        <Alert color="danger" sx={{ mb: 2 }}>
          Error loading users. Please try refreshing.
        </Alert>
      ) : filteredAndSortedUsers.length === 0 ? (
        <Alert color="neutral" sx={{ mb: 2 }}>
          No users found. {searchQuery && 'Try adjusting your search.'}
        </Alert>
      ) : isMobile ? (
        <Stack spacing={1}>
          {(paginatedUsers as AdminUser[]).map(user => {
            const lastLogin = getLastLoginDate(user);
            const status = getActivityStatus(user);
            return (
              <Card key={user.id} variant="outlined" sx={{ p: 1, gap: 0 }}>
                {/* Row 1: name + status chips */}
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography level="body-sm" fontWeight="lg">
                    {user.name || 'No Name'}
                  </Typography>
                  <Stack direction="row" spacing={0.5}>
                    <Chip color={status.color} size="sm">
                      {status.label}
                    </Chip>
                    {user.isAdmin && (
                      <Chip color="warning" size="sm">
                        Admin
                      </Chip>
                    )}
                  </Stack>
                </Stack>

                {/* Row 2: email */}
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  {user.email || 'No Email'}
                </Typography>

                {/* Row 3: credits + last login */}
                <Stack direction="row" spacing={2} sx={{ mt: 0.5 }}>
                  <Typography level="body-xs">
                    Credits: <strong>{(user.currentCredits || 0).toLocaleString()}</strong>
                  </Typography>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Login: {lastLogin ? lastLogin.toLocaleDateString() : 'Never'}
                  </Typography>
                </Stack>

                {/* Row 4: actions */}
                <Stack direction="row" spacing={1} sx={{ mt: 0.75 }}>
                  <ViewUserProfile userId={user.id} size="sm" />
                  <Button
                    size="sm"
                    variant="outlined"
                    color="primary"
                    startDecorator={<CreditCardIcon />}
                    onClick={() => openCreditsModal(user)}
                    sx={{ flex: 1 }}
                  >
                    Adjust Credits
                  </Button>
                </Stack>
              </Card>
            );
          })}
        </Stack>
      ) : (
        <Sheet sx={{ borderRadius: 'md', overflow: 'auto' }}>
          <Table stickyHeader hoverRow sx={{ minWidth: 'auto' }}>
            <thead>
              <tr>
                <th style={{ width: '20%' }}>User</th>
                <th style={{ width: '15%' }}>Credits</th>
                <th style={{ width: '15%' }}>Last Login</th>
                <th style={{ width: '15%' }}>Status</th>
                <th style={{ width: '15%' }}>Created</th>
                <th style={{ width: '20%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(paginatedUsers as AdminUser[]).map(user => {
                const lastLogin = getLastLoginDate(user);
                const status = getActivityStatus(user);
                return (
                  <tr key={user.id}>
                    <td>
                      <Stack>
                        <Typography level="body-sm" fontWeight="lg">
                          {user.name || 'No Name'}
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                          {user.email || 'No Email'}
                        </Typography>
                      </Stack>
                    </td>
                    <td>
                      <Typography level="body-sm" fontWeight="lg" color="primary">
                        {(user.currentCredits || 0).toLocaleString()}
                      </Typography>
                    </td>
                    <td>
                      <Typography level="body-xs">{lastLogin ? lastLogin.toLocaleDateString() : 'Never'}</Typography>
                    </td>
                    <td>
                      <Stack direction="row" spacing={1}>
                        <Chip color={status.color} size="sm">
                          {status.label}
                        </Chip>
                        {user.isAdmin && (
                          <Chip color="warning" size="sm">
                            Admin
                          </Chip>
                        )}
                      </Stack>
                    </td>
                    <td>
                      <Typography level="body-xs">{new Date(user.createdAt).toLocaleDateString()}</Typography>
                    </td>
                    <td>
                      <Stack direction="row" spacing={1}>
                        <ViewUserProfile userId={user.id} size="sm" />
                        <Button
                          size="sm"
                          variant="outlined"
                          color="primary"
                          startDecorator={<CreditCardIcon />}
                          onClick={() => openCreditsModal(user)}
                        >
                          Credits
                        </Button>
                      </Stack>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Sheet>
      )}

      <SharedPaginationControls
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={setCurrentPage}
        itemsPerPage={pageSize}
        onItemsPerPageChange={size => {
          setPageSize(size);
          setCurrentPage(1);
        }}
        totalItems={totalUsers}
        pageLimitOptions={[10, 20, 50, 100]}
      />

      <Snackbar
        open={notification.open}
        color={notification.color}
        onClose={() => setNotification(prev => ({ ...prev, open: false }))}
        autoHideDuration={5000}
        variant="soft"
        sx={{ maxWidth: 400 }}
      >
        {notification.message}
      </Snackbar>

      <CreditAdjustmentModal
        open={creditsModalOpen}
        onClose={() => setCreditsModalOpen(false)}
        selectedUser={selectedUser}
        onCreditAdjustment={handleCreditAdjustment}
      />
    </Box>
  );
};
