'use client';

import nextDynamic from 'next/dynamic';

// The app is a client-rendered SPA, so it never needs a server render. ssr: false keeps the
// providers, the router and every route out of the server function's SSR chunks, which would
// otherwise ship tens of MB of client-only code in the Lambda. The boundary sits in the page,
// not the root layout: around the layout's children it would also hide the segment's notFound()
// from the server render, and a missing asset would get a 200 instead of a 404.
export const SpaShell = nextDynamic(() => import('./SpaApp'), { ssr: false });
