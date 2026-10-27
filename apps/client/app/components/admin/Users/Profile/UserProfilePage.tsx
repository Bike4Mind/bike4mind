import React, { useRef, useState } from 'react';
import { Box, Button, LinearProgress, Modal, ModalDialog, Sheet, Stack, Typography } from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useBlocker, useNavigate } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { ADMIN_TAB_PARAM, ADMIN_USERS_TAB_SLUG } from '@bike4mind/common';
import { useGetUser } from '@client/app/hooks/data/user';
import { FullUsersView } from '../Views/FullUsersView';
import { unsavedFieldLabels } from '../unsavedFieldLabels';
import { parseUserId } from '../usersTabSearch';
import AdminProfileModal from '../../AdminProfileModal';
import ComplianceModal from '../ComplianceModal';
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
  <Stack data-testid={testId} spacing={1} alignItems="flex-start" sx={{ p: 3 }}>
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
  // Field keys, not labels: the card owns what changed, this owns how to say it.
  const [unsavedFields, setUnsavedFields] = useState<string[]>([]);
  // Set when the page leaves on purpose (the user was just deleted), so the guard does not ask.
  const leavingRef = useRef(false);

  const backToUsers = () => navigate({ to: '/admin', search: { [ADMIN_TAB_PARAM]: ADMIN_USERS_TAB_SLUG } });

  // The card stages every edit and sends them only on Update, so leaving silently drops them.
  // Tab switches stay on this path and keep the card mounted, so only a path change is guarded.
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      !leavingRef.current && unsavedFields.length > 0 && current.pathname !== next.pathname,
    enableBeforeUnload: () => unsavedFields.length > 0,
    withResolver: true,
  });

  const handleUserDeleted = () => {
    leavingRef.current = true;
    backToUsers();
  };

  const isNotFound =
    !validUserId || (!user.isFetching && isAxiosError(user.error) && user.error.response?.status === 404);

  const renderBody = () => {
    if (isNotFound) {
      return (
        <Message testId="user-profile-not-found" title="User not found">
          <Typography level="body-sm">No user has the id {userId}. They may have been deleted.</Typography>
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
    return (
      <FullUsersView
        index={0}
        user={user.data}
        variant="page"
        tab={tab}
        onTabChange={onTabChange}
        onUnsavedFieldsChange={setUnsavedFields}
        onUserDeleted={handleUserDeleted}
      />
    );
  };

  return (
    // Admin skin scope (utils/themes/customizations/adminSkin.ts); #5844 moves it to the admin layout root.
    <Sheet data-testid="user-profile-page" data-admin-surface sx={{ minHeight: '100vh', overflowY: 'auto' }}>
      <Box sx={{ maxWidth: 1440, mx: 'auto', p: { xs: 1, sm: 2, md: 3 } }}>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          startDecorator={<ArrowBackIcon />}
          onClick={backToUsers}
          sx={{ mb: 1 }}
          data-testid="user-profile-back-btn"
        >
          Users
        </Button>
        {renderBody()}
      </Box>

      <Modal open={blocker.status === 'blocked'} onClose={() => blocker.reset?.()}>
        <ModalDialog data-testid="user-profile-leave-modal">
          <Typography level="title-md">Discard changes?</Typography>
          <Typography level="body-sm">
            These edits have not been saved: {unsavedFieldLabels(unsavedFields).join(', ')}. Leaving this page discards
            them. Use Update to save instead.
          </Typography>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => blocker.reset?.()}
              data-testid="user-profile-leave-cancel-btn"
            >
              Keep editing
            </Button>
            <Button color="danger" onClick={() => blocker.proceed?.()} data-testid="user-profile-leave-confirm-btn">
              Discard changes
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* Opened from the Overview cards; on /admin the Users tab mounts these instead. */}
      <AdminProfileModal />
      <ComplianceModal />
    </Sheet>
  );
};
