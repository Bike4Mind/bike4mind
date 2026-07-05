'use client';

import nextDynamic from 'next/dynamic';
import { useUser } from '../contexts/UserContext';
import { UserSettingsProvider } from '../contexts/UserSettingsContext';
import { router } from '../router';

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

  const routerComponent = <RouterProvider router={router} />;

  // Authenticated users get the router directly; unauthenticated users are wrapped in UserSettingsProvider.
  return currentUser ? <>{routerComponent}</> : <UserSettingsProvider>{routerComponent}</UserSettingsProvider>;
};
