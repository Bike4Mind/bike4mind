import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

/** Opens the admin profile page of a user; the replacement for the old full-view modal. */
export const useOpenUserProfile = () => {
  const navigate = useNavigate();
  return useCallback((userId: string) => navigate({ to: '/admin/users/$userId', params: { userId } }), [navigate]);
};
