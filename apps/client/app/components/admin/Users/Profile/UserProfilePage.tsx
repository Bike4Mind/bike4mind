import React from 'react';
import { Box, Button, LinearProgress, Sheet, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { ADMIN_TAB_PARAM, ADMIN_USERS_TAB_SLUG } from '@bike4mind/common';
import { useGetUser } from '@client/app/hooks/data/user';
import { parseUserId } from '../usersTabSearch';
import AdminProfileModal from '../../AdminProfileModal';
import ComplianceModal from '../ComplianceModal';
import { UndoToastProvider } from '../../shared';
import { UserProfileView } from './UserProfileView';
import type { UserProfileTab } from './userProfileSearch';

type UserProfilePageProps = {
  userId: string;
  tab: UserProfileTab;
  onTabChange: (tab: UserProfileTab) => void;
};

const Message: React.FC<{ testId: string; title: string; children?: React.ReactNode }> = ({
  testId,
  title,
  children,
}) => (
  <Stack data-testid={testId} spacing={1} alignItems="flex-start" sx={{ py: 3 }}>
    <Typography level="title-lg">{title}</Typography>
    {children}
  </Stack>
);

/** The admin profile of one user at /admin/users/$userId; the route guards it to admins. */
export const UserProfilePage: React.FC<UserProfilePageProps> = ({ userId, tab, onTabChange }) => {
  const navigate = useNavigate();
  // A malformed id never reaches `/api/users/<id>`: it is a not-found, like an unknown one.
  const validUserId = parseUserId(userId) ?? null;
  const user = useGetUser(validUserId);

  const backToUsers = () => navigate({ to: '/admin', search: { [ADMIN_TAB_PARAM]: ADMIN_USERS_TAB_SLUG } });

  const isNotFound =
    !validUserId || (!user.isFetching && isAxiosError(user.error) && user.error.response?.status === 404);

  const renderBody = () => {
    if (isNotFound) {
      return (
        <Message testId="user-profile-not-found" title="User not found">
          <Typography level="body-sm">No user has the id {userId}. They may have been deleted.</Typography>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={backToUsers}
            data-testid="user-profile-back-btn"
          >
            Back to users
          </Button>
        </Message>
      );
    }
    if (user.isLoading) return <LinearProgress data-testid="user-profile-loading" />;
    if (!user.data) {
      return (
        <Message testId="user-profile-error" title="This user could not be loaded">
          <Button size="sm" variant="outlined" onClick={() => user.refetch()}>
            Try again
          </Button>
        </Message>
      );
    }
    return <UserProfileView user={user.data} tab={tab} onTabChange={onTabChange} onBack={backToUsers} />;
  };

  return (
    <Sheet data-testid="user-profile-page" sx={{ minHeight: '100vh', overflowY: 'auto', bgcolor: 'admin.canvas' }}>
      <UndoToastProvider>
        <Box sx={{ maxWidth: 1280, mx: 'auto', px: { xs: 2, sm: 4 }, pt: 2.5, pb: 12 }}>{renderBody()}</Box>
        {/* Opened from the header's More menu; on /admin the Users tab mounts these instead. */}
        <AdminProfileModal />
        <ComplianceModal />
      </UndoToastProvider>
    </Sheet>
  );
};
