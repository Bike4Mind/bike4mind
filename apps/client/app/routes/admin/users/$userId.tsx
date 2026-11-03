import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';
import { UserProfilePage } from '@client/app/components/admin/Users/Profile/UserProfilePage';
import {
  DEFAULT_USER_PROFILE_TAB,
  type UserProfileTab,
} from '@client/app/components/admin/Users/Profile/userProfileSearch';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

const AdminUserProfile = () => {
  useDocumentTitle('User profile', ' | Admin');
  const { userId } = useParams({ from: '/admin-layout/admin/users/$userId' });
  const { tab = DEFAULT_USER_PROFILE_TAB } = useSearch({ from: '/admin-layout/admin/users/$userId' });
  const navigate = useNavigate({ from: '/admin/users/$userId' });

  // Replace, so flipping tabs does not stack history entries for Back to walk through.
  const setTab = useCallback(
    (next: UserProfileTab) =>
      navigate({ search: { tab: next === DEFAULT_USER_PROFILE_TAB ? undefined : next }, replace: true }),
    [navigate]
  );

  return <UserProfilePage userId={userId} tab={tab} onTabChange={setTab} />;
};

export default AdminUserProfile;
