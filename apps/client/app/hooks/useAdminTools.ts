import { useUser } from '@client/app/contexts/UserContext';

interface UseAdminToolsReturn {
  isAdmin: boolean;
  canUseAdminTools: boolean;
}

export function useAdminTools(): UseAdminToolsReturn {
  const { currentUser: user } = useUser();

  // Only check the isAdmin flag; there is no 'Admin' tag in VALID_USER_TAGS.
  const isAdmin = user?.isAdmin || false;
  const canUseAdminTools = isAdmin;

  return {
    isAdmin,
    canUseAdminTools,
  };
}
