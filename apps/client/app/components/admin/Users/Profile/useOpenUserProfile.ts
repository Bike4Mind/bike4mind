import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import type { SignupClassificationContext } from './userProfileSearch';

/** Opens the admin profile page of a user; the replacement for the old full-view modal. */
export const useOpenUserProfile = () => {
  const navigate = useNavigate();
  return useCallback(
    (userId: string, context?: SignupClassificationContext) =>
      navigate({ to: '/admin/users/$userId', params: { userId }, ...(context ? { search: context } : {}) }),
    [navigate]
  );
};
