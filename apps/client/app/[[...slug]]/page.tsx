'use client';

import { TanStackRouterProvider } from '@client/app/components/TanStackRouterProvider';

// This page handles all SPA routes via catch-all routing
export default function Page() {
  return <TanStackRouterProvider />;
}

export const dynamic = 'force-static';
