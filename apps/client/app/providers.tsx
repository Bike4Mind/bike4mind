'use client';

import { lazy, ReactNode, Suspense, useEffect, useState } from 'react';
import { PersistQueryClientProvider, PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { QueryClient } from '@tanstack/react-query';
import { get, set, del } from 'idb-keyval';
import { NuqsAdapter } from 'nuqs/adapters/next/pages';
import { Box, GlobalStyles } from '@mui/joy';
import CssBaseline from '@mui/joy/CssBaseline';
import { ApiProvider } from '@client/app/contexts/ApiContext';
import { resolveStorageEventRedirect } from '@client/app/utils/crossTabLogout';
import { AppTheme } from '@client/app/utils/themes';
import { WebsocketConfigProvider } from '@client/app/contexts/WebsocketConfigProvider';
import { UserProvider } from '@client/app/contexts/UserContext';
import { ServerStatusProvider } from '@client/app/contexts/ServerStatusProvider';
import DefaultMetaTags from '@client/app/components/DefaultMetaTags';
import ConfirmationModal from '@client/app/components/ConfirmationModal';
import WebsocketReactQueryInvalidateListener from '@client/app/components/WebsocketReactQueryInvalidateListener';
import AgentExecutionSubscriber from '@client/app/components/AgentExecutionSubscriber';
import StripeCheckoutSuccessHandler from '@client/app/components/stripe/StripeCheckoutSuccessHandler';
import { Toaster } from 'sonner';
import { CookieConsentBanner } from '@client/app/components/CookieConsentBanner';
import { TranslationProvider } from '@client/app/contexts/TranslationProvider';
import { QuestPreparationOverlay } from '@client/app/components/QuestPreparationOverlay';
import { runLocalStorageCleanup } from '@client/app/utils/localStorageCleanup';

// Lazy load DevTools only when needed (development only)
const ReactQueryDevtools = lazy(() =>
  import('@tanstack/react-query-devtools').then(mod => ({
    default: mod.ReactQueryDevtools,
  }))
);

// Only persist non-user-specific queries that are safe to restore across sessions.
// Allowlist approach: new queries are excluded by default, preventing stale user data.
const PERSISTABLE_QUERY_KEYS = new Set(['server-config-public', 'branding-settings', 'admin-settings']);

function createIDBPersister(idbValidKey: IDBValidKey = 'reactQuery') {
  return {
    persistClient: async (client: PersistedClient) => {
      try {
        await set(idbValidKey, client);
      } catch (error) {
        console.warn('Failed to persist query client:', error);
      }
    },
    restoreClient: async () => {
      return await get<PersistedClient>(idbValidKey);
    },
    removeClient: async () => {
      await del(idbValidKey);
    },
  } as Persister;
}

const persister = createIDBPersister();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

// Next.js exposes buildId in __NEXT_DATA__ at runtime - use as cache buster
// so persisted data is discarded on new deployments.
const buildId =
  typeof window !== 'undefined'
    ? ((window as unknown as { __NEXT_DATA__?: { buildId?: string } }).__NEXT_DATA__?.buildId ?? 'dev')
    : 'dev';

// Core providers that are always needed (minimal overhead)
function CoreProviders({ children }: { children: ReactNode }) {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 1000 * 60 * 60 * 4, // 4 hours (default is 24h)
        buster: buildId,
        dehydrateOptions: {
          shouldDehydrateQuery: query => {
            const key = query.queryKey[0];
            return typeof key === 'string' && PERSISTABLE_QUERY_KEYS.has(key);
          },
        },
      }}
    >
      <ApiProvider>
        <NuqsAdapter>
          <AppTheme>
            <CssBaseline />
            <GlobalStyles
              styles={{
                '& .lucide': {
                  color: 'var(--Icon-color)',
                  margin: 'var(--Icon-margin)',
                  fontSize: 'var(--Icon-fontSize, 20px)',
                  width: '1em',
                  height: '1em',
                },
              }}
            />
            {children}
          </AppTheme>
        </NuqsAdapter>
      </ApiProvider>
    </PersistQueryClientProvider>
  );
}

// Main provider component with conditional loading
// Note: WebsocketProvider is always available but only connects when accessToken exists
export function ClientProviders({ children }: { children: ReactNode }) {
  // Defer Toaster render until after hydration to avoid mismatch
  // (sonner injects a <section> element client-side that doesn't exist in server HTML)
  const [mounted, setMounted] = useState(false);

  // Run TTL-based localStorage cleanup on mount
  useEffect(() => {
    setMounted(true);
    runLocalStorageCleanup();
  }, []);

  // Cross-tab session propagation: when another tab clears the access token -
  // a voluntary logout (resetTokens()), a failed mid-session refresh (markSessionExpired()),
  // or a security-forced logout (forceLogoutTokens()) - redirect this tab to /login.
  // The 'storage' event only fires in OTHER tabs, so this won't loop.
  useEffect(() => {
    // Translate the cross-tab token change into a redirect target. resolveCrossTabRedirect
    // mirrors the in-tab 401 UX: a failed mid-session refresh -> session_expired,
    // a security-forced logout -> session_revoked, a voluntary logout -> plain /login. It
    // returns null when the other tab is still authenticated (e.g. a token refresh).
    const handleStorageChange = (e: StorageEvent) => {
      const target = resolveStorageEventRedirect(e, window.location);
      if (target) {
        window.location.replace(target);
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  return (
    <CoreProviders>
      {mounted && <Toaster richColors closeButton position="bottom-right" />}
      {mounted && !!(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID) && (
        <CookieConsentBanner />
      )}
      <TranslationProvider>
        <DefaultMetaTags />
        <main>
          {/* WebsocketConfigProvider fetches WebSocket URL at runtime from serverConfig. */}
          {/* Kept outside UserProvider to preserve SSR compatibility — the security */}
          {/* improvement is at the API layer (serverConfig now requires auth). Pre-auth, */}
          {/* useConfig() returns undefined so the WebSocket URL stays undefined and the */}
          {/* connection is never established until the user authenticates. */}
          <WebsocketConfigProvider>
            <WebsocketReactQueryInvalidateListener />
            <AgentExecutionSubscriber />
            <Suspense fallback={null}>
              <StripeCheckoutSuccessHandler />
            </Suspense>
            <UserProvider>
              <ServerStatusProvider>
                <QuestPreparationOverlay />
                <Box sx={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100dvh' }}>{children}</Box>
                <ConfirmationModal />
              </ServerStatusProvider>
            </UserProvider>
          </WebsocketConfigProvider>
        </main>
      </TranslationProvider>
      {/* Lazy load DevTools only when explicitly enabled */}
      {process.env.NEXT_PUBLIC_ENABLE_DEVTOOLS === 'true' && (
        <Suspense fallback={null}>
          <ReactQueryDevtools initialIsOpen={false} />
        </Suspense>
      )}
    </CoreProviders>
  );
}
