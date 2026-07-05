import { useEffect } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useNavigate } from '@tanstack/react-router';

export function useRequireAuth(redirectTo: string = '/login') {
  const { currentUser } = useUser();
  const navigate = useNavigate();

  useEffect(() => {
    if (!currentUser) {
      navigate({ to: redirectTo });
    }
  }, [currentUser, redirectTo, navigate]);

  return currentUser;
}
