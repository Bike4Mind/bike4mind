// The ban targets client routing hooks (useRouter/usePathname); notFound() is the App Router's
// server-only 404 signal, which has no TanStack equivalent.
// eslint-disable-next-line no-restricted-imports -- notFound() is a server-only App Router API, not a client routing hook
import { notFound } from 'next/navigation';
import { TanStackRouterProvider } from '@client/app/components/TanStackRouterProvider';
import { isStaticAssetPath } from './isStaticAssetPath';

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

// Catch-all SPA route: every path no earlier route matched renders the client router, so a
// full-page load of any client route works. Asset-shaped paths are the exception - a request
// for a file that does not exist must be a 404, not the HTML shell.
export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  if (isStaticAssetPath(slug)) notFound();
  return <TanStackRouterProvider />;
}

export const dynamic = 'force-static';
