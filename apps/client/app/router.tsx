import { FC, lazy, LazyExoticComponent, Suspense, useState } from 'react';
import { captureUtmParams } from '@client/app/utils/utmCapture';
import { holdDiscoveryForCampaign } from '@client/lib/gears/discovery';
import { beaconVisit } from '@client/app/utils/visitBeacon';
import { beaconPage, startPageBeacon } from '@client/app/utils/pageBeacon';
import type { GitHubLakeCallbackSearch } from '@client/app/utils/githubLakeCallbackStep';
import { captureGitHubLakeCallbackSearch, GITHUB_LAKE_CALLBACK_PATH } from '@client/app/utils/githubLakeCallbackSearch';
import { requireGitHubLakeCallbackSession } from '@client/app/utils/githubLakeCallbackGuard';
import { captureMcpOAuthCallbackSearch, requireMcpOAuthCallbackSession } from '@client/app/utils/mcpOAuthCallback';
import {
  createRouter,
  createRoute,
  createRootRoute,
  createBrowserHistory,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { CircularProgress, Box, Typography } from '@mui/joy';
import AccountDeletionPendingGate from '@client/app/components/auth/AccountDeletionPendingGate';
import NotebookLayout from '@client/app/components/layouts/Notebook';
import { useUser } from '@client/app/contexts/UserContext';
import { buildRedirectTo } from '@client/app/utils/authRedirect';
import { billingLandingHref, parseBillingView } from '@client/app/utils/billingDeepLink';
import { enforceConsentRedirect } from '@client/app/utils/consentGuard';
import { takeTicket } from './routes/partners/bedrocknewsClaimTicket';
import { captureCodeFromFragment } from './routes/personas/personaRedeemCode';
import { captureEmailLinkToken } from './utils/emailLinkToken';
import { bootstrapSession } from '@client/app/utils/sessionBootstrap';
import useDataLakeMode from '@client/app/hooks/useDataLakeMode';

// Keep layout components as eager imports for optimal performance
import RestrictedPage from './components/common/RestrictedPage';
import { AdminLayoutRoute } from './components/admin/AdminLayout';
import { adminPageFrame } from './components/admin/shared/adminStyles';
import NotFound from './components/NotFound';
import ExperimentalFeatureGate from './components/common/ExperimentalFeatureGate';
import { ProviderBundle } from './contexts/ProviderBundle';
import { premiumRoutes } from './premium-generated/premiumRoutes.generated';
import { partitionPremiumRoutes } from './premiumRoutePartition';
import { defaultFeedbackRollupWindow } from './utils/feedbackRollupWindow';
import { lazyWithPreload } from './utils/lazyWithPreload';
import { parseStudioMedium } from './components/Studio/studioModality';
import { hasQaSearchKeys, parseQaStatusSearch } from './hooks/data/qaStatus';
import { parseAdminSearch } from './components/admin/adminTabParams';
import { legacyUserLinkRedirect, parseUserProfileSearch } from './components/admin/Users/Profile/userProfileSearch';
import { parseSubscriptionDetailSearch } from './components/admin/Subscriptions/Detail/subscriptionDetailSearch';
import { parseModelDetailSearch } from './components/admin/Models/modelDetailSearch';
import { optionalStringSearchValue } from './utils/optionalStringSearchValue';
import {
  isIntegrationsPageSource,
  PERSONA_LOGIN_PAGE_PATH,
  SUBSCRIBER_SOURCES,
  type IntegrationsPageSource,
  type SubscriberSource,
} from '@bike4mind/common';

// Lazy load all route components for code splitting
// /new and /notebooks/$id render through one shell (see notebookShellRoute).
const NotebookShell = lazyWithPreload(() => import('./routes/notebooks/shell'));
const ProjectsPage = lazy(() => import('./routes/projects'));
const ProjectPage = lazy(() => import('./routes/projects/$id'));
const ProfilePage = lazy(() => import('./routes/profile/index'));
const GearsPage = lazy(() => import('./routes/gears/index'));
const IntegrationsPage = lazy(() => import('./routes/integrations/index'));
const ProfileDetailPage = lazy(() => import('./routes/profile/$id'));
const SubscriptionsCheckoutPage = lazy(() => import('./routes/subscriptions/checkout'));
const BillingDeepLinkModals = lazy(() => import('./components/subscription/BillingDeepLinkModals'));
const AgentsPage = lazy(() => import('./routes/agents'));
const NewAgentPage = lazy(() => import('./routes/agents/new'));
const AgentDetailPage = lazy(() => import('./routes/agents/$id'));
const EditAgentPage = lazy(() => import('./routes/agents/$id/edit'));
const SkillsPage = lazy(() => import('./routes/skills'));
const NewSkillPage = lazy(() => import('./routes/skills/new'));
const SkillDetailPage = lazy(() => import('./routes/skills/$id'));
const EditSkillPage = lazy(() => import('./routes/skills/$id/edit'));
const SkillMarketPage = lazy(() => import('./routes/skills/market'));
const SkillListingPage = lazy(() => import('./routes/skills/market/$listingId'));
const UnlistedSkillListingPage = lazy(() => import('./routes/skills/market/u/$token'));
const MySkillListingsPage = lazy(() => import('./routes/skills/market/mine'));
const SkillReviewQueuePage = lazy(() => import('./routes/skills/market/review'));
const AgentExecutionHistoryPage = lazy(() => import('./routes/agent-executions'));
const FeedbackRollupPage = lazy(() => import('./routes/feedback/rollup'));
const MissionDossierPage = lazy(() => import('./routes/agents/$id/missions/$missionId'));
const DeepAgentConsolePage = lazy(() => import('./routes/deep-agents'));
const QaStatusPage = lazy(() => import('./routes/admin/qa'));
const QaRunPage = lazy(() => import('./routes/admin/qa/runs/$id'));
const QaTestPage = lazy(() => import('./routes/admin/qa/tests/$testKey'));
const SharePage = lazy(() => import('./routes/share/$id'));
const ReportPublicPage = lazy(() => import('./routes/report/$id'));
const OrganizationsPage = lazy(() => import('./routes/organizations'));
const OrganizationDetailPage = lazy(() => import('./routes/organizations/$id'));
const SpacesPage = lazy(() => import('./routes/spaces'));
const SpaceDetailPage = lazy(() => import('./routes/spaces/$id'));
const AuthCallbackPage = lazy(() => import('./routes/auth/$strategy/callback'));
const AuthSuccessPage = lazy(() => import('./routes/auth/success'));
const LoginPage = lazy(() => import('./routes/login'));
const RegisterPage = lazy(() => import('./routes/register'));
const AcceptPoliciesPage = lazy(() => import('./routes/accept-policies'));
const AccountDataExportPage = lazy(() => import('./routes/account-data-export/$jobId'));
const VerifyEmailPage = lazy(() => import('./routes/verify-email'));
const VerifyEmailChangePage = lazy(() => import('./routes/verify-change'));
const SubscribePage = lazy(() => import('./routes/subscribe'));
const ArtifactsPage = lazy(() => import('./routes/artifacts/index'));
const ArtifactPage = lazy(() => import('./routes/artifacts/$id'));
const FunctionsPage = lazy(() => import('./routes/functions/index'));
const FunctionPage = lazy(() => import('./routes/functions/$id'));
const ComposerLabPage = lazy(() => import('./routes/composer-lab'));
const AdminEmergencyPage = lazy(() => import('./routes/admin-emergency'));
const GoogleDriveCallbackPage = lazy(() => import('./routes/google-drive/callback'));
const GitHubLakeCallbackPage = lazy(() => import('./routes/data-lakes/github/callback'));
const HomePage = lazy(() => import('./routes/index'));
const Admin = lazy(() => import('./routes/admin'));
const AdminUserProfilePage = lazy(() => import('./routes/admin/users/$userId'));
const AdminSubscriptionDetailPage = lazy(() => import('./routes/admin/subscriptions/$subscriptionId'));
const AdminModelDetailPage = lazy(() => import('./routes/admin/models/$'));
const AdminModelDiscoveryRunPage = lazy(() => import('./routes/admin/models/runs/$runId'));
const AdminSubscriptionByStripeIdPage = lazy(
  () => import('./routes/admin/subscriptions/by-stripe/$stripeSubscriptionId')
);
const SlackInstallPage = lazy(() => import('./routes/integrations/slack/install'));
const SlackSuccessPage = lazy(() => import('./routes/integrations/slack/success'));
const SlackErrorPage = lazy(() => import('./routes/integrations/slack/error'));
const EmailUnsubscribePage = lazy(() => import('./routes/email/unsubscribe'));
const DesktopDownloadPage = lazy(() => import('./routes/desktop'));
const ArenaPage = lazy(() => import('./routes/arena'));
const McpOAuthCallbackPage = lazy(() => import('./routes/integrations/mcp-oauth-callback'));
const AtlassianSelectSitePage = lazy(() => import('./routes/integrations/atlassian/select-site'));
const ActivatePage = lazy(() => import('./routes/activate'));
const OAuthAuthorizePage = lazy(() => import('./routes/oauth/authorize'));
const OAuthLogoutPage = lazy(() => import('./routes/oauth/logout'));
const BedrockNewsClaimPage = lazy(() => import('./routes/partners/bedrocknews-claim'));
const PersonaRedeemPage = lazy(() => import('./routes/personas/redeem'));
const HudPage = lazy(() => import('./routes/hud'));
const HearthPage = lazy(() => import('./routes/hearth'));
const StudioPage = lazy(() => import('./routes/studio/$modality'));
const StudioProductionsPage = lazy(() => import('./routes/studio/productions'));
const StudioProductionEditorPage = lazy(() => import('./routes/studio/productions.$compositionId'));
const StudioLibraryPage = lazy(() => import('./routes/studio/library'));

// Shared coercion for the optional string search params nearly every route declares.
// A few routes below deliberately keep a stricter `typeof === 'string'` guard instead,
// which is not the same thing - do not fold those in.
const optionalStringParam = (search: Record<string, unknown>, key: string): string | undefined =>
  optionalStringSearchValue(search[key]);

// AI-themed loading messages for route transitions
const loadingMessages = [
  'Warming up the neural networks...',
  'Teaching robots to dream...',
  'Waking up the AI models...',
  'Initializing cognitive engines...',
  'Brewing digital intelligence...',
  'Summoning artificial wisdom...',
  'Powering up silicon synapses...',
  'Training the digital brain...',
  'Loading consciousness modules...',
];

// Simple loading fallback for route transitions - centered in viewport with creative AI message
function RouteLoadingFallback() {
  // Select a random loading message once
  const [loadingMessage] = useState(() => loadingMessages[Math.floor(Math.random() * loadingMessages.length)]);

  return (
    <Box
      data-testid="route-loading"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        gap: 2,
      }}
    >
      <CircularProgress aria-label="Loading page" data-testid="route-loading-spinner" />
      <Typography level="body-md" sx={{ color: 'text.tertiary' }} data-testid="route-loading-message">
        {loadingMessage}
      </Typography>
    </Box>
  );
}

// Builds the gated element for a premium route (RestrictedPage -> Suspense -> the
// lazy page). `lazy()` runs once per descriptor here, not per render. The
// `component:` render fn stays inline in each createRoute below (matching the
// core route pattern) so eslint's react/display-name rule is satisfied.
function buildPremiumGatedElement(descriptor: (typeof premiumRoutes)[number]) {
  const LazyComponent = lazy(descriptor.lazyImport);
  return (
    <RestrictedPage
      requireEntitlement={descriptor.requireEntitlement}
      requireFeatureTag={descriptor.requireFeatureTag}
      fallbackPath={descriptor.fallbackPath}
    >
      <Suspense fallback={<RouteLoadingFallback />}>
        <LazyComponent />
      </Suspense>
    </RestrictedPage>
  );
}

// Standalone premium routes hang off the root route (own chrome) and supply their
// own ProviderBundle; app-shell premium routes hang off layoutRoute (rendered
// inside the notebook layout) and inherit ProviderBundle + chrome from its
// Outlet, so wrapping again would double the context providers and their API
// fetches. Admin premium routes hang off adminLayoutRoute the same way: its guard,
// providers and Suspense boundary already wrap them. getParentRoute is a thunk
// (lazy), so referencing rootRoute/layoutRoute/adminLayoutRoute (declared below)
// is safe. In the open-core fork `premiumRoutes` is empty -> every array is empty.
const premiumPartition = partitionPremiumRoutes(premiumRoutes);

// Public premium routes render bare under the root route: the URL is the authorization,
// so there is no RestrictedPage, and no ProviderBundle either, whose providers fetch a
// signed-in user's data that a visitor with no session does not have.
const builtPublicPremiumRoutes = premiumPartition.public.map(descriptor => {
  const LazyComponent = lazy(descriptor.lazyImport);
  return createRoute({
    getParentRoute: () => rootRoute,
    path: descriptor.path,
    component: () => (
      <Suspense fallback={<RouteLoadingFallback />}>
        <LazyComponent />
      </Suspense>
    ),
  });
});
const builtStandalonePremiumRoutes = premiumPartition.standalone.map(descriptor => {
  const gated = buildPremiumGatedElement(descriptor);
  return createRoute({
    getParentRoute: () => rootRoute,
    path: descriptor.path,
    // Standalone premium pages bypass the layoutRoute consent guard (they hang off rootRoute),
    // so opt them in via the shared guard like the other standalone routes (issue #382).
    beforeLoad: ({ location }) => enforceConsentRedirect(location),
    component: () => <ProviderBundle>{gated}</ProviderBundle>,
  });
});
const builtAppShellPremiumRoutes = premiumPartition.appShell.map(descriptor => {
  const gated = buildPremiumGatedElement(descriptor);
  return createRoute({
    getParentRoute: () => layoutRoute,
    path: descriptor.path,
    component: () => gated,
  });
});
// The frame is what a core admin detail route spreads on its own root, so a contributed page sets
// no outer padding of its own. Access (full admins only) is the layout's, not the route's.
const builtAdminPremiumRoutes = premiumPartition.admin.map(descriptor => {
  const LazyComponent = lazy(descriptor.lazyImport);
  return createRoute({
    getParentRoute: () => adminLayoutRoute,
    path: descriptor.path,
    component: () => (
      <Box data-testid="admin-contributed-page" sx={adminPageFrame}>
        <LazyComponent />
      </Box>
    ),
  });
});

// Root route that wraps all other routes
function RootComponent() {
  // NotebookLayout draws its own main beside the sidebar nav, so only pages outside it get one here.
  // display: contents keeps the page a direct child of the providers' grid.
  const inNotebookLayout = useRouterState({ select: s => s.matches.some(m => m.routeId === layoutRoute.id) });
  // The data export download page stays reachable so an export requested before the deletion can
  // still be collected during the grace period (the server gate allows its GET).
  const onDataExportDownload = useRouterState({
    select: s => s.matches.some(m => m.routeId === accountDataExportRoute.id),
  });
  // At the root so every route, including those outside ProviderBundle, shows only the cancel
  // screen for a deletion-pending session.
  return (
    <>
      <AccountDeletionPendingGate exempt={onDataExportDownload}>
        {inNotebookLayout ? (
          <Outlet />
        ) : (
          <Box component="main" sx={{ display: 'contents' }}>
            <Outlet />
          </Box>
        )}
      </AccountDeletionPendingGate>
      {process.env.NEXT_PUBLIC_ENABLE_DEVTOOLS === 'true' && <TanStackRouterDevtools position="top-right" />}
    </>
  );
}

const rootRoute = createRootRoute({
  component: RootComponent,
});

// Layout route for authenticated pages that need NotebookLayout
const layoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'layout',
  beforeLoad: async ({ location }) => {
    // Cold-load ordering: the access token is memory-only, so a fresh page load has no session
    // until the HttpOnly refresh cookie is exchanged. This guard must wait for that - firing on
    // a not-yet-populated currentUser would redirect to /login, whose on-mount
    // clearClientCaches() + removeQueries() tears the session down before it can establish.
    // bootstrapSession() resolves instantly once the answer is known, so only the first
    // navigation of a page load actually waits.
    await bootstrapSession();

    const { currentUser } = useUser.getState();
    if (!currentUser) {
      const redirectTo = buildRedirectTo(
        location.pathname,
        location.searchStr,
        location.hash ? `#${location.hash}` : ''
      );
      throw redirect({
        to: '/login',
        search: redirectTo ? { redirectTo } : undefined,
      });
    }

    // P0-B abuse gate: route an authenticated-but-not-yet-consented account (in practice a
    // brand-new OAuth/SAML/OTC user) to the acceptance interstitial. Shared with the standalone
    // rootRoute children so the guard can't drift (see enforceConsentRedirect / issue #382).
    await enforceConsentRedirect(location);

    // Handle redirects stored in sessionStorage to work around CloudFront Access Denied
    // on SPA routes (CloudFront can only serve "/" directly; all other paths return 403).
    // Supported keys: __slack_redirect (Slack OAuth), __stripe_return (Stripe billing portal).
    if (location.pathname === '/') {
      for (const key of ['__slack_redirect', '__stripe_return']) {
        const value = sessionStorage.getItem(key);
        if (value) {
          let parsedUrl: URL | null = null;
          try {
            parsedUrl = new URL(value, window.location.origin);
          } catch {
            sessionStorage.removeItem(key);
            console.warn('[Router] Ignoring malformed sessionStorage redirect URL:', value);
            continue;
          }
          sessionStorage.removeItem(key);
          // throw redirect() must be outside any try/catch so TanStack Router can intercept it.
          throw redirect({
            to: parsedUrl.pathname,
            search: Object.fromEntries(parsedUrl.searchParams),
          });
        }
      }
    }
  },
  component: () => (
    <RestrictedPage requireAdmin={false}>
      {/* These providers are not usually needed in an unprotected page. This prevents unnecessary API fetch */}
      <ProviderBundle>
        <NotebookLayout>
          <Outlet />
          <Suspense fallback={null}>
            <BillingDeepLinkModals />
          </Suspense>
        </NotebookLayout>
      </ProviderBundle>
    </RestrictedPage>
  ),
});

// Index route (replaces /index.tsx)
const indexRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <HomePage />
    </Suspense>
  ),
});

// Pathless parent of /new and /notebooks/$id. Its component - one SessionContainer and chat
// provider - stays mounted across /new -> /notebooks/<optimistic id> -> /notebooks/<real id>, so a
// first send never remounts the chat it is streaming into. The children render no component of
// their own: the shell renders each one's route effects itself (routes/notebooks/shell.tsx).
const notebookShellRoute = createRoute({
  getParentRoute: () => layoutRoute,
  id: 'notebook-shell',
  loader: () => {
    void NotebookShell.preload();
  },
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <NotebookShell />
    </Suspense>
  ),
});

// New notebook route (replaces /new.tsx)
export const newRoute = createRoute({
  getParentRoute: () => notebookShellRoute,
  path: '/new',
  validateSearch: (
    search: Record<string, unknown>
  ): { projectId?: string; goal?: string; article?: string; passage?: string } => {
    return {
      projectId: optionalStringParam(search, 'projectId'),
      goal: optionalStringParam(search, 'goal'),
      // Data Lake article deep link, forwarded here from the retired /data-lakes route (#1943).
      article: optionalStringParam(search, 'article'),
      passage: optionalStringParam(search, 'passage'),
    };
  },
});

// Notebook route with dynamic ID (replaces /notebooks/[id].tsx)
const notebookRoute = createRoute({
  getParentRoute: () => notebookShellRoute,
  path: '/notebooks/$id',
  // `questId` is the turn anchor a feedback deep link carries (see common/utils/deepLinks) - the
  // session loads normally and ChatHistory scrolls to that turn once it has rendered.
  validateSearch: (search: Record<string, unknown>): { projectId?: string; questId?: string } => {
    return {
      projectId: optionalStringParam(search, 'projectId'),
      questId: optionalStringParam(search, 'questId'),
    };
  },
});

// Gears - the feature tour, where each feature's one-time reward is claimed (one card per feature).
const gearsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/gears',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <GearsPage />
    </Suspense>
  ),
});

// Integrations - the directory of every integration and model provider, with roadmap requests.
// Exported so the page reads `?source=` (its analytics entry point) with integrationsRoute.useSearch().
export const CONNECTIONS_TABS = ['integrations', 'api-keys'] as const;
export type ConnectionsTab = (typeof CONNECTIONS_TABS)[number];

export const integrationsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/integrations',
  validateSearch: (search: Record<string, unknown>): { source?: IntegrationsPageSource; tab?: ConnectionsTab } => ({
    source: isIntegrationsPageSource(search.source) ? search.source : undefined,
    tab: CONNECTIONS_TABS.find(t => t === search.tab),
  }),
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <IntegrationsPage />
    </Suspense>
  ),
});

// Preference arena - verified users compare two blind answers and earn capped promotional credits.
const arenaRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/arena',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <ArenaPage />
    </Suspense>
  ),
});

// Projects index route (replaces /projects/index.tsx)
const projectsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/projects',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <ProjectsPage />
    </Suspense>
  ),
});

// Project route with dynamic ID (replaces /projects/[id]/index.tsx)
const projectRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/projects/$id',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <ProjectPage />
    </Suspense>
  ),
});

// Profile index route (replaces /profile/index.tsx)
const profileRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/profile',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <ProfilePage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { tab?: string; subtab?: string; section?: string } => {
    return {
      tab: optionalStringParam(search, 'tab'),
      subtab: optionalStringParam(search, 'subtab'),
      section: optionalStringParam(search, 'section'),
    };
  },
});

// Personal feedback rollup. Exported so the page reads its window with
// `feedbackRollupRoute.useSearch()` rather than an untyped `{ strict: false }` cast.
export const feedbackRollupRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/feedback/rollup',
  // The default window is resolved HERE, not in the component: the bounds are part of the rollup
  // query key, so a default recomputed per render would refetch without end, and leaving them
  // undefined would keep a bare /feedback/rollup permanently disabled behind the hook's guard.
  validateSearch: (search: Record<string, unknown>): { from: string; to: string } => {
    const fallback = defaultFeedbackRollupWindow();
    return {
      from: typeof search.from === 'string' && search.from.length > 0 ? search.from : fallback.from,
      to: typeof search.to === 'string' && search.to.length > 0 ? search.to : fallback.to,
    };
  },
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <FeedbackRollupPage />
    </Suspense>
  ),
});

// Profile route with dynamic ID (replaces /profile/[id].tsx)
const profileDetailRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/profile/$id',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <ProfileDetailPage />
    </Suspense>
  ),
});

// Subscriptions checkout route (replaces /subscriptions/checkout.tsx)
const subscriptionsCheckoutRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/subscriptions/checkout',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <SubscriptionsCheckoutPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { plan?: string } => {
    return {
      plan: optionalStringParam(search, 'plan'),
    };
  },
});

// Shareable billing entry points (/billing/credits, /billing/plans) for emails and marketing CTAs.
// Under layoutRoute so a signed-out visitor goes through /login?redirectTo= and lands here after.
export const billingRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/billing/$view',
  beforeLoad: ({ params }) => {
    throw redirect({ href: billingLandingHref(parseBillingView(params.view)), replace: true });
  },
});

// Guessed URLs with no page of their own. Chats are listed in the sidenav, so /notebooks lands on
// the app home; /subscriptions opens the plans modal the way /billing/plans does.
export const notebooksIndexRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/notebooks',
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true });
  },
});

export const subscriptionsIndexRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/subscriptions',
  beforeLoad: () => {
    throw redirect({ href: billingLandingHref('plans'), replace: true });
  },
});

const AGENT_FEATURE_GATE = {
  feature: 'enableAgents' as const,
  featureName: 'Agents',
  description: 'Create AI assistants with specialized capabilities that can be invoked with @mentions in chat.',
};

const HEARTH_FEATURE_GATE = {
  feature: 'enableHearth' as const,
  featureName: 'Hearth',
  description: 'A shared event log where you, your agents, and your devices all post and catch up as actors.',
};

// Hearth channel view (minimal projection of the shared event log)
const hearthRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/hearth',
  component: () => (
    <ExperimentalFeatureGate {...HEARTH_FEATURE_GATE} loadingFallback={<RouteLoadingFallback />}>
      <Suspense fallback={<RouteLoadingFallback />}>
        <HearthPage />
      </Suspense>
    </ExperimentalFeatureGate>
  ),
});

// Studio: one page per generation modality (/studio/video), each a CapabilityForm and the gallery of the user's jobs.
export const studioRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/studio/$modality',
  params: {
    parse: ({ modality }) => ({ modality: parseStudioMedium(modality) }),
    stringify: ({ modality }) => ({ modality }),
  },
  component: function StudioRouteComponent() {
    const { modality } = studioRoute.useParams();
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <StudioPage modality={modality} />
      </Suspense>
    );
  },
});

// Create v2's other two areas. Static, so they win over /studio/$modality; each 404s until its flag is open.
export const studioProductionsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/studio/productions',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <StudioProductionsPage />
    </Suspense>
  ),
});

// One production open in the timeline editor. Static prefix, so it never collides with /studio/$modality.
export const studioProductionEditorRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/studio/productions/$compositionId',
  component: function StudioProductionEditorRouteComponent() {
    const { compositionId } = studioProductionEditorRoute.useParams();
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <StudioProductionEditorPage compositionId={compositionId} />
      </Suspense>
    );
  },
});

export const studioLibraryRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/studio/library',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <StudioLibraryPage />
    </Suspense>
  ),
});

// Agents index route (replaces /agents/index.tsx)
const agentsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/agents',
  component: () => (
    <ExperimentalFeatureGate {...AGENT_FEATURE_GATE} loadingFallback={<RouteLoadingFallback />}>
      <Suspense fallback={<RouteLoadingFallback />}>
        <AgentsPage />
      </Suspense>
    </ExperimentalFeatureGate>
  ),
});

// New agent route (replaces /agents/new.tsx)
const newAgentRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/agents/new',
  component: () => (
    <ExperimentalFeatureGate {...AGENT_FEATURE_GATE} loadingFallback={<RouteLoadingFallback />}>
      <Suspense fallback={<RouteLoadingFallback />}>
        <NewAgentPage />
      </Suspense>
    </ExperimentalFeatureGate>
  ),
});

// Agent detail route (replaces /agents/[id].tsx)
const agentDetailRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/agents/$id',
  component: () => (
    <ExperimentalFeatureGate {...AGENT_FEATURE_GATE} loadingFallback={<RouteLoadingFallback />}>
      <Suspense fallback={<RouteLoadingFallback />}>
        <AgentDetailPage />
      </Suspense>
    </ExperimentalFeatureGate>
  ),
});

// Edit agent route (replaces /agents/[id]/edit.tsx)
const editAgentRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/agents/$id/edit',
  component: () => (
    <ExperimentalFeatureGate {...AGENT_FEATURE_GATE} loadingFallback={<RouteLoadingFallback />}>
      <Suspense fallback={<RouteLoadingFallback />}>
        <EditAgentPage />
      </Suspense>
    </ExperimentalFeatureGate>
  ),
});

// Skills routes - Claude-Code-style reusable instruction templates.
// Not gated behind an experimental flag for v1: skills are a pure productivity
// surface and the only failure mode of accessing an empty list is a friendly
// empty state.
const skillsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/skills',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <SkillsPage />
    </Suspense>
  ),
});

const newSkillRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/skills/new',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <NewSkillPage />
    </Suspense>
  ),
});

// Skill Market. Static `market` segments outrank the `/skills/$id` param route in Tanstack's
// ranking, so /skills/market never resolves as a skill id.
const marketRoute = <TPath extends string>(path: TPath, Page: LazyExoticComponent<FC>) =>
  createRoute({
    getParentRoute: () => layoutRoute,
    path,
    component: () => (
      <Suspense fallback={<RouteLoadingFallback />}>
        <Page />
      </Suspense>
    ),
  });
const skillMarketRoute = marketRoute('/skills/market', SkillMarketPage);
const mySkillListingsRoute = marketRoute('/skills/market/mine', MySkillListingsPage);
const skillReviewQueueRoute = marketRoute('/skills/market/review', SkillReviewQueuePage);
const unlistedSkillListingRoute = marketRoute('/skills/market/u/$token', UnlistedSkillListingPage);
const skillListingRoute = marketRoute('/skills/market/$listingId', SkillListingPage);

const skillDetailRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/skills/$id',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <SkillDetailPage />
    </Suspense>
  ),
});

const editSkillRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/skills/$id/edit',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <EditSkillPage />
    </Suspense>
  ),
});

// Mission dossier - a deep-agent mission of a B4M agent (same agents gate)
const agentMissionRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/agents/$id/missions/$missionId',
  component: () => (
    <ExperimentalFeatureGate {...AGENT_FEATURE_GATE} loadingFallback={<RouteLoadingFallback />}>
      <Suspense fallback={<RouteLoadingFallback />}>
        <MissionDossierPage />
      </Suspense>
    </ExperimentalFeatureGate>
  ),
});

// Agent execution history route - gated behind the same agents feature flag
// since it's only meaningful when agent runs have occurred.
// Exported so the route component can read its `validateSearch`-typed search via
// `agentExecutionHistoryRoute.useSearch()` instead of an untyped `{ strict: false }` cast.
export const agentExecutionHistoryRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/agent-executions',
  // `expand` deep-links to a single execution's trace (the "View trace"
  // toast launcher); `session` namespaces the replay-store entry for it.
  validateSearch: (search: Record<string, unknown>): { expand?: string; session?: string } => ({
    expand: typeof search.expand === 'string' ? search.expand : undefined,
    session: typeof search.session === 'string' ? search.session : undefined,
  }),
  component: () => (
    <ExperimentalFeatureGate {...AGENT_FEATURE_GATE} loadingFallback={<RouteLoadingFallback />}>
      <Suspense fallback={<RouteLoadingFallback />}>
        <AgentExecutionHistoryPage />
      </Suspense>
    </ExperimentalFeatureGate>
  ),
});

// Deep Agent Console - long-horizon autonomous agents (admin-gated while the
// framework matures; matches the spin API's admin/dev gate).
const deepAgentsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/deep-agents',
  component: () => (
    <RestrictedPage requireAdmin>
      <Suspense fallback={<RouteLoadingFallback />}>
        <DeepAgentConsolePage />
      </Suspense>
    </RestrictedPage>
  ),
});

// Share route (replaces /share/[id].tsx)
const shareRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/share/$id',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <SharePage />
    </Suspense>
  ),
});

// Report-a-public-page route - auth-gated; linked from served /p/ pages.
const reportPublicRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/report/$id',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <ReportPublicPage />
    </Suspense>
  ),
});

// Organizations index route (replaces /organizations/index.tsx)
const organizationsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/organizations',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <OrganizationsPage />
    </Suspense>
  ),
});

// Organization detail route (replaces /organizations/[id].tsx)
const organizationDetailRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/organizations/$id',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <OrganizationDetailPage />
    </Suspense>
  ),
  // Declares `tab` and the Integrations tab's `section` as this route's search contract, mirroring
  // profileRoute. The page reads them via useSearch({ strict: false }), so this types the params
  // rather than being what makes them work. Deliberately not exhaustive: the Slack org-connect
  // callback returns to this route carrying slack_connected/slack_error, which OrgSlackIntegration
  // reads loosely. Keep those reads loose, or declare the params here too - a strict schema listing
  // only `tab` and `section` would hide them.
  validateSearch: (search: Record<string, unknown>): { tab?: string; section?: string } => {
    return { tab: optionalStringParam(search, 'tab'), section: optionalStringParam(search, 'section') };
  },
});

const spacesRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/spaces',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <SpacesPage />
    </Suspense>
  ),
});

const spaceDetailRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/spaces/$id',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <SpaceDetailPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: optionalStringParam(search, 'tab'),
  }),
});

// Auth callback route (replaces /auth/[strategy]/callback.tsx) - no layout needed
const authCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/$strategy/callback',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <AuthCallbackPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { code?: string; state?: string } => {
    return {
      code: optionalStringParam(search, 'code'),
      state: optionalStringParam(search, 'state'),
    };
  },
});

// Auth success route (replaces /auth/success.tsx) - no layout needed
const authSuccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/success',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <AuthSuccessPage />
    </Suspense>
  ),
  validateSearch: (
    search: Record<string, unknown>
  ): { token?: string; error?: string; userId?: string; redirectTo?: string } => {
    return {
      token: optionalStringParam(search, 'token'),
      error: optionalStringParam(search, 'error'),
      userId: optionalStringParam(search, 'userId'),
      redirectTo: optionalStringParam(search, 'redirectTo'),
    };
  },
});

// Login route (replaces /login.tsx)
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <LoginPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { error?: string; redirectTo?: string } => {
    return {
      error: optionalStringParam(search, 'error'),
      redirectTo: optionalStringParam(search, 'redirectTo'),
    };
  },
});

// Register route (replaces /register.tsx)
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <RegisterPage />
    </Suspense>
  ),
});

// AUP/ToS + 18+ acceptance interstitial (P0-B abuse gate). A rootRoute child (NOT under
// layoutRoute) so it does not inherit the consent beforeLoad guard below - otherwise it would
// redirect to itself.
const acceptPoliciesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-policies',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <AcceptPoliciesPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { redirectTo?: string } => {
    return {
      redirectTo: optionalStringParam(search, 'redirectTo'),
    };
  },
});

// Download page linked from the data export email. A rootRoute child without the consent guard, and
// exempt from AccountDeletionPendingGate in RootComponent, so an account pending deletion can still
// collect an export it requested (the server's deletionPendingGate allows the GET).
const accountDataExportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account-data-export/$jobId',
  beforeLoad: async ({ location }) => {
    await bootstrapSession();
    if (!useUser.getState().currentUser) {
      const redirectTo = buildRedirectTo(
        location.pathname,
        location.searchStr,
        location.hash ? `#${location.hash}` : ''
      );
      throw redirect({ to: '/login', search: redirectTo ? { redirectTo } : undefined });
    }
  },
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <AccountDataExportPage />
    </Suspense>
  ),
});

// Verify email route (replaces /verify-email.tsx)
// The link's token is taken out of the address at module load (captureEmailLinkToken below), so the page
// reads it from there, not from the search.
const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <VerifyEmailPage />
    </Suspense>
  ),
});

// Verify email change route (replaces /verify-change.tsx)
// The link's token is taken out of the address at module load (captureEmailLinkToken below), so the page
// reads it from there, not from the search.
const verifyEmailChangeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-change',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <VerifyEmailChangePage />
    </Suspense>
  ),
});

// Admin emergency route (replaces /admin-emergency.tsx)
const adminEmergencyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin-emergency',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <AdminEmergencyPage />
    </Suspense>
  ),
});

// Google Drive callback route (replaces /google-drive/callback.tsx)
const googleDriveCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/google-drive/callback',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <GoogleDriveCallbackPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { code?: string } => {
    return {
      code: optionalStringParam(search, 'code'),
    };
  },
});

// Where a custom MCP connector's authorization server redirects back; the page posts the one-time parameters to the API.
const mcpOAuthCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/integrations/mcp-oauth-callback',
  beforeLoad: ({ location }) => requireMcpOAuthCallbackSession(location),
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <McpOAuthCallbackPage />
    </Suspense>
  ),
});

// Data-lake GitHub App return: its OAuth Callback URL points here, and with OAuth-during-install on, the install return lands here too.
const gitHubLakeCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: GITHUB_LAKE_CALLBACK_PATH,
  beforeLoad: ({ location }) => requireGitHubLakeCallbackSession(location),
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <GitHubLakeCallbackPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): GitHubLakeCallbackSearch => ({
    installation_id: optionalStringParam(search, 'installation_id'),
    code: optionalStringParam(search, 'code'),
    state: optionalStringParam(search, 'state'),
    error: optionalStringParam(search, 'error'),
    setup_action: optionalStringParam(search, 'setup_action'),
  }),
});

// Subscribe route (replaces /subscribe.tsx)
const subscribeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/subscribe',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <SubscribePage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { source?: SubscriberSource } => ({
    source: SUBSCRIBER_SOURCES.find(source => source === search.source),
  }),
});

// The signed-in user's artifacts library, and one artifact by id.
const artifactsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/artifacts',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <ArtifactsPage />
    </Suspense>
  ),
});

const artifactRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/artifacts/$id',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <ArtifactPage />
    </Suspense>
  ),
});

// The callable functions library: the user's own functions and those shared with them, and one by id.
const functionsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/functions',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <FunctionsPage />
    </Suspense>
  ),
});

const functionRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/functions/$id',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <FunctionPage />
    </Suspense>
  ),
});

// The old demo gallery's URL, kept so bookmarks land on the library.
const artifactsDemoRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/artifacts-demo',
  beforeLoad: () => {
    throw redirect({ to: '/artifacts', replace: true });
  },
});

// Composer status-line states with mock data, for design work (routes/composer-lab.tsx).
const composerLabRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/composer-lab',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <ComposerLabPage />
    </Suspense>
  ),
});

// The standalone Data Lakes page was retired in #1943 - its capabilities live in the in-chat
// surface (DataLakeChatSurface). This route survives ONLY to keep already-shared `?article=`
// deep links working: it turns Data Lake mode on and forwards into a fresh chat, which opens the
// article in the viewer. There is no page component behind it.
export const dataLakesRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/data-lakes',
  validateSearch: (search: Record<string, unknown>): { article?: string; passage?: string } => ({
    // Shareable deep link to a specific article within a lake.
    article: typeof search.article === 'string' && search.article ? search.article : undefined,
    // Cited passage to highlight once the article opens (from a findings "Open document" link).
    passage: optionalStringParam(search, 'passage'),
  }),
  beforeLoad: ({ search }) => {
    // The store is the mode's source of truth on /new (no session exists yet to carry
    // forceKnowledgeRetrieval), so flipping it here is what makes the tree open on arrival.
    // Deliberately UNGATED by EnableDataLakes: beforeLoad cannot read the admin-settings
    // context, and on a cold load that query has not resolved, so a gate here would read as
    // "off" and break the deep link for entitled users. DataLakeChatSurface re-checks the flag
    // before rendering, so an unentitled arrival leaves this flag set but inert.
    useDataLakeMode.getState().setEnabled(true);
    throw redirect({
      to: '/new',
      search: search.article ? { article: search.article, ...(search.passage ? { passage: search.passage } : {}) } : {},
    });
  },
  component: () => null,
});

// The Keep HUD route (local agent command interface)
const hudRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/hud',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <HudPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: optionalStringParam(search, 'tab'),
  }),
});

// Slack integration routes (no layout)
const slackInstallRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/integrations/slack/install',
  beforeLoad: ({ location }) => enforceConsentRedirect(location),
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <SlackInstallPage />
    </Suspense>
  ),
});

const slackSuccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/integrations/slack/success',
  beforeLoad: ({ location }) => enforceConsentRedirect(location),
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <SlackSuccessPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { workspace?: string; reinstall?: boolean; teamId?: string } => {
    return {
      workspace: optionalStringParam(search, 'workspace'),
      teamId: optionalStringParam(search, 'teamId'),
      reinstall: search.reinstall === 'true' || search.reinstall === true,
    };
  },
});

const slackErrorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/integrations/slack/error',
  beforeLoad: ({ location }) => enforceConsentRedirect(location),
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <SlackErrorPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { reason?: string } => {
    return {
      reason: optionalStringParam(search, 'reason'),
    };
  },
});

// Atlassian integration routes (no layout)
// Note: resources param is now deprecated (fetched from server instead)
const atlassianSelectSiteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/integrations/atlassian/select-site',
  beforeLoad: ({ location }) => enforceConsentRedirect(location),
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <AtlassianSelectSitePage />
    </Suspense>
  ),
});

// Device activation route (OAuth device flow). A rootRoute child (own chrome, not the notebook
// layout), so it does NOT inherit the layoutRoute consent guard - it opts in via the shared
// enforceConsentRedirect so an authenticated-but-not-yet-consented user is routed to
// /accept-policies (preserving a return path back to /activate?code=...) instead of being shown the
// form only to have Approve Device fail the server consent gate with a misleading 403. The
// unauthenticated -> /login redirect stays in the component (the guard is a no-op without a
// currentUser). See issues #369 and #382.
const activateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activate',
  beforeLoad: ({ location }) => enforceConsentRedirect(location),
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <ActivatePage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { code?: string } => {
    return {
      code: optionalStringParam(search, 'code'),
    };
  },
});

// Admin layout: every admin page renders inside it, so the guard, the providers and the sidebar
// are wired once (AdminLayoutRoute) and no admin page can go full-screen. Pathless, so the
// children keep their URLs and every `to: '/admin'` stays typed against the console's search.
const adminLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'admin-layout',
  beforeLoad: ({ location }) => enforceConsentRedirect(location),
  component: () => <AdminLayoutRoute fallback={<RouteLoadingFallback />} adminPages={premiumPartition.admin} />,
});

// The tabbed admin console (replaces /admin/index.tsx)
export const adminRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin',
  beforeLoad: async ({ search }) => {
    // The user view used to be a modal held in `?userId=`; keep those shared links working.
    const legacyUserLink = legacyUserLinkRedirect(search);
    if (legacyUserLink) throw redirect(legacyUserLink);
  },
  component: Admin,
  // `tab` (a stable slug, never the positional AdminTab enum value - see common/utils/deepLinks)
  // makes the console addressable, and each tab's own params come from the registry in
  // adminTabParams.ts, which the tab-sync hook rebuilds the URL from too.
  validateSearch: parseAdminSearch,
});

// Admin user profile; adminRoute redirects its legacy `?userId=` here.
export const adminUserProfileRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/users/$userId',
  component: AdminUserProfilePage,
  validateSearch: parseUserProfileSearch,
});

// Admin subscription detail, opened from the Subscriptions tab and the profile's subscription cards.
export const adminSubscriptionDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/subscriptions/$subscriptionId',
  component: AdminSubscriptionDetailPage,
  validateSearch: parseSubscriptionDetailSearch,
});

// Resolves a Stripe `sub_...` id to the detail page. The static `by-stripe` segment outranks the
// `$subscriptionId` param in TanStack's ranking, so the detail route never captures it.
export const adminSubscriptionByStripeIdRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/subscriptions/by-stripe/$stripeSubscriptionId',
  component: AdminSubscriptionByStripeIdPage,
});

// Admin model detail. A splat, so model ids keep their `/`, `:` and spaces in the path (local-image/<checkpoint>,
// Bedrock `...:0`); the Models tab's list rows open it.
export const adminModelDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/models/$',
  component: AdminModelDetailPage,
  validateSearch: parseModelDetailSearch,
});

// One model discovery run. The static `runs` segment outranks the detail splat in TanStack's ranking.
export const adminModelDiscoveryRunRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/models/runs/$runId',
  component: AdminModelDiscoveryRunPage,
});

// QA status (full admins only, via the admin layout). Exported so pages read typed search/params via
// `qaStatusRoute.useSearch()` etc.; filters live in the URL so links deep-link.
export const qaStatusRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/qa',
  validateSearch: parseQaStatusSearch,
  component: () => (
    <RestrictedPage requireAdmin>
      <Box sx={adminPageFrame}>
        <Suspense fallback={<RouteLoadingFallback />}>
          <QaStatusPage />
        </Suspense>
      </Box>
    </RestrictedPage>
  ),
});

export const qaRunRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/qa/runs/$id',
  component: () => (
    <RestrictedPage requireAdmin>
      <Box sx={adminPageFrame}>
        <Suspense fallback={<RouteLoadingFallback />}>
          <QaRunPage />
        </Suspense>
      </Box>
    </RestrictedPage>
  ),
});

// The router encodes the key into one segment (it contains / > ? #); the page
// re-sends it as ?testKey=.
export const qaTestRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/qa/tests/$testKey',
  component: () => (
    <RestrictedPage requireAdmin>
      <Box sx={adminPageFrame}>
        <Suspense fallback={<RouteLoadingFallback />}>
          <QaTestPage />
        </Suspense>
      </Box>
    </RestrictedPage>
  ),
});

// The QA pages used to live under /status (links already sent, e.g. in Slack, still point there);
// each old URL redirects to its /admin/qa twin. These stay under the root so no layout renders first.
export const legacyQaStatusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/status',
  beforeLoad: ({ search }) => {
    if (hasQaSearchKeys(search)) {
      throw redirect({ to: '/admin/qa', search: parseQaStatusSearch(search), replace: true });
    }
    throw redirect({ to: '/admin/qa', replace: true });
  },
});

export const legacyQaRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/status/runs/$id',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/admin/qa/runs/$id', params: { id: params.id }, search: true, replace: true });
  },
});

export const legacyQaTestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/status/tests/$testKey',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/admin/qa/tests/$testKey',
      params: { testKey: params.testKey },
      search: true,
      replace: true,
    });
  },
});

export const legacyQaSegmentlessRoutes = ['/status/runs', '/status/tests'].map(path =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      throw redirect({ to: '/admin/qa', replace: true });
    },
  })
);

// Email unsubscribe route - public page for managing email preferences
// The link's token is taken out of the address at module load (captureEmailLinkToken below), so the page
// reads it from there, not from the search.
const emailUnsubscribeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/email/unsubscribe',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <EmailUnsubscribePage />
    </Suspense>
  ),
});

// Desktop app download page - no layout, public, so it can be linked from anywhere.
const desktopDownloadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/desktop',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <DesktopDownloadPage />
    </Suspense>
  ),
});

// BedrockNews Headword credit claim - no layout; the page sends signed-out visitors to /login itself
const bedrockNewsClaimRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/partners/bedrocknews/claim',
  // The ticket is moved out of the URL first so a consent redirect never carries it in its return path.
  beforeLoad: ({ location, search }) => {
    takeTicket(search.ticket);
    return enforceConsentRedirect({ pathname: location.pathname, searchStr: '', hash: '' });
  },
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <BedrockNewsClaimPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { ticket?: string } => ({
    ticket: optionalStringParam(search, 'ticket'),
  }),
});

// Test-persona sign-in (the mint response's login_path) - no layout, public. The code arrives in the
// fragment and is moved out of the address before render; the page POSTs it to the redeem API.
const personaRedeemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PERSONA_LOGIN_PAGE_PATH,
  beforeLoad: () => captureCodeFromFragment(),
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <PersonaRedeemPage />
    </Suspense>
  ),
});

// OAuth Authorization endpoint - no layout, public
const oauthAuthorizeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/oauth/authorize',
  beforeLoad: ({ location }) => enforceConsentRedirect(location),
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <OAuthAuthorizePage />
    </Suspense>
  ),
  validateSearch: (
    search: Record<string, unknown>
  ): {
    client_id?: string;
    redirect_uri?: string;
    response_type?: string;
    scope?: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    nonce?: string;
  } => ({
    client_id: optionalStringParam(search, 'client_id'),
    redirect_uri: optionalStringParam(search, 'redirect_uri'),
    response_type: optionalStringParam(search, 'response_type'),
    scope: optionalStringParam(search, 'scope'),
    state: optionalStringParam(search, 'state'),
    code_challenge: optionalStringParam(search, 'code_challenge'),
    code_challenge_method: optionalStringParam(search, 'code_challenge_method'),
    nonce: optionalStringParam(search, 'nonce'),
  }),
});

// OIDC RP-Initiated Logout (end_session_endpoint) - no layout, public. No consent redirect: signing
// out must not wait on accepting the policies.
export const oauthLogoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/oauth/logout',
  beforeLoad: () => bootstrapSession(),
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <OAuthLogoutPage />
    </Suspense>
  ),
  validateSearch: (
    search: Record<string, unknown>
  ): {
    client_id?: string;
    post_logout_redirect_uri?: string;
    state?: string;
    id_token_hint?: string;
  } => ({
    client_id: optionalStringParam(search, 'client_id'),
    post_logout_redirect_uri: optionalStringParam(search, 'post_logout_redirect_uri'),
    state: optionalStringParam(search, 'state'),
    id_token_hint: optionalStringParam(search, 'id_token_hint'),
  }),
});

// Create the route tree
const routeTree = rootRoute.addChildren([
  // Layout-wrapped routes (main app)
  layoutRoute.addChildren([
    indexRoute,
    notebookShellRoute.addChildren([newRoute, notebookRoute]),
    gearsRoute,
    integrationsRoute,
    arenaRoute,
    projectsRoute,
    projectRoute,
    profileRoute,
    profileDetailRoute,
    feedbackRollupRoute,
    subscriptionsCheckoutRoute,
    billingRoute,
    notebooksIndexRoute,
    subscriptionsIndexRoute,
    agentsRoute,
    newAgentRoute,
    agentDetailRoute,
    editAgentRoute,
    skillsRoute,
    newSkillRoute,
    skillDetailRoute,
    editSkillRoute,
    skillMarketRoute,
    mySkillListingsRoute,
    skillReviewQueueRoute,
    unlistedSkillListingRoute,
    skillListingRoute,
    agentExecutionHistoryRoute,
    agentMissionRoute,
    deepAgentsRoute,
    shareRoute,
    reportPublicRoute,
    organizationsRoute,
    organizationDetailRoute,
    spacesRoute,
    spaceDetailRoute,
    artifactsRoute,
    artifactRoute,
    functionsRoute,
    functionRoute,
    artifactsDemoRoute,
    composerLabRoute,
    dataLakesRoute,
    hudRoute,
    hearthRoute,
    studioRoute,
    studioProductionsRoute,
    studioProductionEditorRoute,
    studioLibraryRoute,
    ...builtAppShellPremiumRoutes,
  ]),
  legacyQaStatusRoute,
  legacyQaRunRoute,
  legacyQaTestRoute,
  ...legacyQaSegmentlessRoutes,
  // Standalone auth routes (no layout)
  authCallbackRoute,
  authSuccessRoute,
  loginRoute,
  registerRoute,
  acceptPoliciesRoute,
  accountDataExportRoute,
  verifyEmailRoute,
  verifyEmailChangeRoute,
  adminEmergencyRoute,
  googleDriveCallbackRoute,
  mcpOAuthCallbackRoute,
  gitHubLakeCallbackRoute,
  subscribeRoute,
  activateRoute,
  adminLayoutRoute.addChildren([
    adminRoute,
    adminUserProfileRoute,
    adminSubscriptionDetailRoute,
    adminSubscriptionByStripeIdRoute,
    adminModelDetailRoute,
    adminModelDiscoveryRunRoute,
    qaStatusRoute,
    qaRunRoute,
    qaTestRoute,
    ...builtAdminPremiumRoutes,
  ]),
  ...builtStandalonePremiumRoutes,
  ...builtPublicPremiumRoutes,
  // Slack integration routes (no layout)
  slackInstallRoute,
  slackSuccessRoute,
  slackErrorRoute,
  emailUnsubscribeRoute,
  desktopDownloadRoute,
  // Atlassian integration routes (no layout)
  atlassianSelectSiteRoute,
  // OAuth Authorization endpoint
  oauthAuthorizeRoute,
  oauthLogoutRoute,
  bedrockNewsClaimRoute,
  personaRedeemRoute,
]);

// createBrowserHistory() monkey-patches window.history.pushState/replaceState to detect
// external navigation. Since TanStack Router is the sole owner of client-side routing,
// we don't need that detection - and it conflicts with Next.js App Router, which calls
// replaceState inside useInsertionEffect (where React forbids state updates).
// Removing the monkey-patch is safe: TanStack's own navigation notifies subscribers
// directly via history.push()/replace(), and back/forward works via the popstate listener.
function createNextCompatibleHistory() {
  const prev = [window.history.pushState, window.history.replaceState] as const;
  const history = createBrowserHistory();
  [window.history.pushState, window.history.replaceState] = prev;
  return history;
}

// Capture campaign UTM params at module load - before the router resolves routes and the auth
// guard redirects an unauthenticated landing to /login (which strips the query string). See
// captureUtmParams() for why this cannot live in a React effect. A campaign landing also holds
// the gears discovery modal, so it does not open over the visitor's first screen.
if (captureUtmParams()) holdDiscoveryForCampaign(Date.now());

// Same constraint for the data-lake GitHub App return: the router's first resolve rewrites its query.
captureGitHubLakeCallbackSearch();
captureMcpOAuthCallbackSearch();

// An email link's token (verification or unsubscribe) leaves the address before anything sends a request (the visit
// beacon below carries the page URL as its Referer) and before the router builds its first location.
captureEmailLinkToken();

// Then tell the server a visit is happening. Order matters: the beacon is the request the
// server reads the campaign cookie from, so it has to follow the line above. It also takes a
// verified-hop token off the URL, which has to happen before the router below rewrites it.
beaconVisit();
// After the visit beacon, which carries this load's page when consent allows; the page beacon
// reports the pages after it, and needs to start before the router's first resolve.
startPageBeacon();

// Create the router
export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFound,
  ...(typeof window !== 'undefined' && { history: createNextCompatibleHistory() }),
});

// Each page the router settles on; beaconPage() skips a page the server already has from this load.
if (typeof window !== 'undefined') router.subscribe('onResolved', beaconPage);

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
  interface HistoryState {
    // Prefill for /subscribe; see useJoinWaitlist.
    waitlistEmail?: string;
  }
}
