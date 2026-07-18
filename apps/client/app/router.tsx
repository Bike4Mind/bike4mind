import { lazy, Suspense, useState } from 'react';
import { captureUtmParams } from '@client/app/utils/utmCapture';
import {
  createRouter,
  createRoute,
  createRootRoute,
  createBrowserHistory,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { CircularProgress, Box, Typography } from '@mui/joy';
import NotebookLayout from '@client/app/components/layouts/Notebook';
import { useUser } from '@client/app/contexts/UserContext';
import { buildRedirectTo } from '@client/app/utils/authRedirect';
import { enforceConsentRedirect } from '@client/app/utils/consentGuard';

// Keep layout components as eager imports for optimal performance
import RestrictedPage from './components/common/RestrictedPage';
import NotFound from './components/NotFound';
import ExperimentalFeatureGate from './components/common/ExperimentalFeatureGate';
import { ProviderBundle } from './contexts/ProviderBundle';
import { premiumRoutes } from './premium-generated/premiumRoutes.generated';

// Lazy load all route components for code splitting
const NewNotebookPage = lazy(() => import('./routes/notebooks/new'));
const NotebookPage = lazy(() => import('./routes/notebooks/$id'));
const ProjectsPage = lazy(() => import('./routes/projects'));
const ProjectPage = lazy(() => import('./routes/projects/$id'));
const ProfilePage = lazy(() => import('./routes/profile/index'));
const GearsPage = lazy(() => import('./routes/gears/index'));
const ProfileDetailPage = lazy(() => import('./routes/profile/$id'));
const SubscriptionsCheckoutPage = lazy(() => import('./routes/subscriptions/checkout'));
const AgentsPage = lazy(() => import('./routes/agents'));
const NewAgentPage = lazy(() => import('./routes/agents/new'));
const AgentDetailPage = lazy(() => import('./routes/agents/$id'));
const EditAgentPage = lazy(() => import('./routes/agents/$id/edit'));
const SkillsPage = lazy(() => import('./routes/skills'));
const NewSkillPage = lazy(() => import('./routes/skills/new'));
const SkillDetailPage = lazy(() => import('./routes/skills/$id'));
const EditSkillPage = lazy(() => import('./routes/skills/$id/edit'));
const AgentExecutionHistoryPage = lazy(() => import('./routes/agent-executions'));
const MissionDossierPage = lazy(() => import('./routes/agents/$id/missions/$missionId'));
const DeepAgentConsolePage = lazy(() => import('./routes/deep-agents'));
const SharePage = lazy(() => import('./routes/share/$id'));
const ReportPublicPage = lazy(() => import('./routes/report/$id'));
const OrganizationsPage = lazy(() => import('./routes/organizations'));
const OrganizationDetailPage = lazy(() => import('./routes/organizations/$id'));
const AuthCallbackPage = lazy(() => import('./routes/auth/$strategy/callback'));
const AuthSuccessPage = lazy(() => import('./routes/auth/success'));
const LoginPage = lazy(() => import('./routes/login'));
const RegisterPage = lazy(() => import('./routes/register'));
const AcceptPoliciesPage = lazy(() => import('./routes/accept-policies'));
const VerifyEmailPage = lazy(() => import('./routes/verify-email'));
const VerifyEmailChangePage = lazy(() => import('./routes/verify-change'));
const SubscribePage = lazy(() => import('./routes/subscribe'));
const TutorialsPage = lazy(() => import('./routes/tutorials'));
const ArtifactsDemoPage = lazy(() => import('./routes/artifacts-demo'));
const AdminEmergencyPage = lazy(() => import('./routes/admin-emergency'));
const GoogleDriveCallbackPage = lazy(() => import('./routes/google-drive/callback'));
const HomePage = lazy(() => import('./routes/index'));
const Admin = lazy(() => import('./routes/admin'));
const QuestsPage = lazy(() => import('./routes/quests'));
const SlackInstallPage = lazy(() => import('./routes/integrations/slack/install'));
const SlackSuccessPage = lazy(() => import('./routes/integrations/slack/success'));
const SlackErrorPage = lazy(() => import('./routes/integrations/slack/error'));
const EmailUnsubscribePage = lazy(() => import('./routes/email/unsubscribe'));
const AtlassianSelectSitePage = lazy(() => import('./routes/integrations/atlassian/select-site'));
const ActivatePage = lazy(() => import('./routes/activate'));
const OAuthAuthorizePage = lazy(() => import('./routes/oauth/authorize'));
const DataLakesPage = lazy(() => import('./routes/data-lakes'));
const HudPage = lazy(() => import('./routes/hud'));

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
// fetches. getParentRoute is a thunk (lazy), so referencing rootRoute/layoutRoute
// (declared below) is safe. In the open-core fork `premiumRoutes` is empty -> both
// arrays are empty.
const builtStandalonePremiumRoutes = premiumRoutes
  .filter(d => !d.appShell)
  .map(descriptor => {
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
const builtAppShellPremiumRoutes = premiumRoutes
  .filter(d => d.appShell)
  .map(descriptor => {
    const gated = buildPremiumGatedElement(descriptor);
    return createRoute({
      getParentRoute: () => layoutRoute,
      path: descriptor.path,
      component: () => gated,
    });
  });

// Root route that wraps all other routes
function RootComponent() {
  return (
    <>
      <Outlet />
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
  beforeLoad: ({ location }) => {
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
    enforceConsentRedirect(location);

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

// New notebook route (replaces /new.tsx)
const newRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/new',
  loader: () => {
    // Kick off the NotebookPage chunk download while the user is typing their first
    // message. By the time they hit send and the optimistic navigation fires, the
    // chunk is already cached so the Suspense boundary resolves instantly.
    void import('./routes/notebooks/$id');
  },
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <NewNotebookPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { projectId?: string; questmaster?: string; goal?: string } => {
    return {
      projectId: search.projectId ? String(search.projectId) : undefined,
      questmaster: search.questmaster ? String(search.questmaster) : undefined,
      goal: search.goal ? String(search.goal) : undefined,
    };
  },
});

// Notebook route with dynamic ID (replaces /notebooks/[id].tsx)
const notebookRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/notebooks/$id',
  // fallback={null}: if the chunk isn't ready yet (e.g. user sent before preload
  // finished), show nothing rather than the jarring full-screen loader.
  component: () => (
    <Suspense fallback={null}>
      <NotebookPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { projectId?: string } => {
    return {
      projectId: search.projectId ? String(search.projectId) : undefined,
    };
  },
});

// Gears - the earned-nav progression page (one card per major feature).
const gearsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/gears',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <GearsPage />
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
      tab: search.tab ? String(search.tab) : undefined,
      subtab: search.subtab ? String(search.subtab) : undefined,
      section: search.section ? String(search.section) : undefined,
    };
  },
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
      plan: search.plan ? String(search.plan) : undefined,
    };
  },
});

const AGENT_FEATURE_GATE = {
  feature: 'enableAgents' as const,
  featureName: 'Agents',
  description: 'Create AI assistants with specialized capabilities that can be invoked with @mentions in chat.',
};

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
      code: search.code ? String(search.code) : undefined,
      state: search.state ? String(search.state) : undefined,
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
  ): { token?: string; refreshToken?: string; error?: string; userId?: string; redirectTo?: string } => {
    return {
      token: search.token ? String(search.token) : undefined,
      refreshToken: search.refreshToken ? String(search.refreshToken) : undefined,
      error: search.error ? String(search.error) : undefined,
      userId: search.userId ? String(search.userId) : undefined,
      redirectTo: search.redirectTo ? String(search.redirectTo) : undefined,
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
      error: search.error ? String(search.error) : undefined,
      redirectTo: search.redirectTo ? String(search.redirectTo) : undefined,
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
      redirectTo: search.redirectTo ? String(search.redirectTo) : undefined,
    };
  },
});

// Verify email route (replaces /verify-email.tsx)
const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <VerifyEmailPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { token?: string } => {
    return {
      token: search.token ? String(search.token) : undefined,
    };
  },
});

// Verify email change route (replaces /verify-change.tsx)
const verifyEmailChangeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-change',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <VerifyEmailChangePage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { token?: string } => {
    return {
      token: search.token ? String(search.token) : undefined,
    };
  },
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
      code: search.code ? String(search.code) : undefined,
    };
  },
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
});

// Tutorials route (replaces /tutorials.tsx)
const tutorialsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/tutorials',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <TutorialsPage />
    </Suspense>
  ),
});

// Artifacts demo route (replaces /artifacts-demo.tsx)
const artifactsDemoRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/artifacts-demo',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <ArtifactsDemoPage />
    </Suspense>
  ),
});

// Quests route
const questsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/quests',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <QuestsPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { filter?: string; search?: string } => {
    return {
      filter: search.filter ? String(search.filter) : undefined,
      search: search.search ? String(search.search) : undefined,
    };
  },
});

// Data Lakes home - top-level, Opti-independent destination for a user's own lakes
// (browse + manage). Gated for discovery by the EnableDataLakes admin flag in the
// sidebar nav; the /api/data-lakes/* endpoints enforce the flag server-side.
const dataLakesRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/data-lakes',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <DataLakesPage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { article?: string } => ({
    // Shareable deep link to a specific article within a lake.
    article: typeof search.article === 'string' && search.article ? search.article : undefined,
  }),
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
    tab: search.tab ? String(search.tab) : undefined,
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
      workspace: search.workspace ? String(search.workspace) : undefined,
      teamId: search.teamId ? String(search.teamId) : undefined,
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
      reason: search.reason ? String(search.reason) : undefined,
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
      code: search.code ? String(search.code) : undefined,
    };
  },
});

// Admin route (replaces /admin/index.tsx)
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  beforeLoad: ({ location }) => enforceConsentRedirect(location),
  component: () => (
    <RestrictedPage requireAdmin={true}>
      {/* These providers are not usually needed in an unprotected page. This prevents unnecessary API fetch */}
      <ProviderBundle>
        <Suspense fallback={<RouteLoadingFallback />}>
          <Admin />
        </Suspense>
      </ProviderBundle>
    </RestrictedPage>
  ),
  validateSearch: (search: Record<string, unknown>): { emergency_access?: string } => {
    return {
      emergency_access: search.emergency_access ? String(search.emergency_access) : undefined,
    };
  },
});

// Email unsubscribe route - public page for managing email preferences
const emailUnsubscribeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/email/unsubscribe',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <EmailUnsubscribePage />
    </Suspense>
  ),
  validateSearch: (search: Record<string, unknown>): { token?: string } => {
    return {
      token: search.token ? String(search.token) : undefined,
    };
  },
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
    client_id: search.client_id ? String(search.client_id) : undefined,
    redirect_uri: search.redirect_uri ? String(search.redirect_uri) : undefined,
    response_type: search.response_type ? String(search.response_type) : undefined,
    scope: search.scope ? String(search.scope) : undefined,
    state: search.state ? String(search.state) : undefined,
    code_challenge: search.code_challenge ? String(search.code_challenge) : undefined,
    code_challenge_method: search.code_challenge_method ? String(search.code_challenge_method) : undefined,
    nonce: search.nonce ? String(search.nonce) : undefined,
  }),
});

// Create the route tree
const routeTree = rootRoute.addChildren([
  // Layout-wrapped routes (main app)
  layoutRoute.addChildren([
    indexRoute,
    newRoute,
    notebookRoute,
    gearsRoute,
    projectsRoute,
    projectRoute,
    profileRoute,
    profileDetailRoute,
    subscriptionsCheckoutRoute,
    agentsRoute,
    newAgentRoute,
    agentDetailRoute,
    editAgentRoute,
    skillsRoute,
    newSkillRoute,
    skillDetailRoute,
    editSkillRoute,
    agentExecutionHistoryRoute,
    agentMissionRoute,
    deepAgentsRoute,
    shareRoute,
    reportPublicRoute,
    organizationsRoute,
    organizationDetailRoute,
    tutorialsRoute,
    artifactsDemoRoute,
    questsRoute,
    dataLakesRoute,
    hudRoute,
    ...builtAppShellPremiumRoutes,
  ]),
  // Standalone auth routes (no layout)
  authCallbackRoute,
  authSuccessRoute,
  loginRoute,
  registerRoute,
  acceptPoliciesRoute,
  verifyEmailRoute,
  verifyEmailChangeRoute,
  adminEmergencyRoute,
  googleDriveCallbackRoute,
  subscribeRoute,
  activateRoute,
  adminRoute,
  ...builtStandalonePremiumRoutes,
  // Slack integration routes (no layout)
  slackInstallRoute,
  slackSuccessRoute,
  slackErrorRoute,
  emailUnsubscribeRoute,
  // Atlassian integration routes (no layout)
  atlassianSelectSiteRoute,
  // OAuth Authorization endpoint
  oauthAuthorizeRoute,
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
// captureUtmParams() for why this cannot live in a React effect.
captureUtmParams();

// Create the router
export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFound,
  ...(typeof window !== 'undefined' && { history: createNextCompatibleHistory() }),
});

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
