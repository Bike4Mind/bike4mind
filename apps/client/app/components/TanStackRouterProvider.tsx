'use client';

import nextDynamic from 'next/dynamic';
import { useLayoutEffect } from 'react';
import { useUser } from '../contexts/UserContext';
import { UserSettingsProvider } from '../contexts/UserSettingsContext';
import { router } from '../router';
import { captureEmailLinkToken } from '../utils/emailLinkToken';

const RouterProvider = nextDynamic(() => import('@tanstack/react-router').then(mod => mod.RouterProvider), {
  ssr: false,
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export const TanStackRouterProvider = () => {
  const { currentUser } = useUser();

  // router.tsx already took an email link's token off the address at module load, but Next's App Router
  // writes the URL it read at boot back on its first commit (an insertion effect, so before this). Clear
  // it again here, before any effect sends a request.
  useLayoutEffect(captureEmailLinkToken, []);

  const routerComponent = <RouterProvider router={router} />;

  // Authenticated users get the router directly; unauthenticated users are wrapped in UserSettingsProvider.
  return currentUser ? <>{routerComponent}</> : <UserSettingsProvider>{routerComponent}</UserSettingsProvider>;
};
