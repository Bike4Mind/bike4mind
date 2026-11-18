'use client';

import { ClientProviders } from '@client/app/providers';
import { TanStackRouterProvider } from '@client/app/components/TanStackRouterProvider';

// The whole client app, loaded only in the browser through SpaShell.
export default function SpaApp() {
  return (
    <ClientProviders>
      <TanStackRouterProvider />
    </ClientProviders>
  );
}
