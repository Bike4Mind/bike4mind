import { createHashHistory, createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { resolveSettingsLink, type SettingsLink } from './chat/settingsNavigation';
import { AppMenuBridge } from './appMenu/AppMenuBridge';
import { DevLogsWindow } from './devlog/DevLogsWindow';
import { AppErrorFallback } from './errors/AppErrorFallback';
import { reportRenderError } from './errors/renderError';
import { Home } from './routes/Home';
import { Profile } from './routes/Profile';
import { Billing } from './routes/Billing';
import { Settings } from './routes/Settings';
import { OrchestrateMini } from './orchestrateMini/OrchestrateMini';
import { MiniTavern } from './watch/MiniTavern';

const rootRoute = createRootRoute({
  component: function RootLayout() {
    return (
      <>
        <AppMenuBridge />
        <Outlet />
      </>
    );
  },
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Home,
});

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile',
  component: Profile,
});

const billingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/billing',
  component: Billing,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  // Old `section` values (servers, import, worktrees) still land on the row that replaced them.
  validateSearch: (search: Record<string, unknown>): SettingsLink => resolveSettingsLink(search),
  component: function SettingsRoute() {
    const { section, setting, focus } = settingsRoute.useSearch();
    return <Settings section={section ?? 'general'} setting={setting} importFocus={focus} />;
  },
});

// Its own window, opened by a chord rather than navigated to from the app: see
// main/devlog/window.ts. A route rather than a second html entry so it inherits the same
// bundle, theme and preload bridge.
const devLogsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dev-logs',
  component: DevLogsWindow,
});

// The always-on-top mini Tavern window (main/watch/miniWindow.ts). Its preload exposes only
// window.b4mMini, so nothing on this route may reach for window.b4m.
const miniTavernRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mini-tavern',
  component: function MiniTavernRoute() {
    return <MiniTavern />;
  },
});

// The always-on-top Orchestrate mini window (main/orchestrateMini). Its preload exposes only
// window.b4mOrchestrateMini, so nothing on this route may reach for window.b4m.
const orchestrateMiniRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/orchestrate-mini',
  component: function OrchestrateMiniRoute() {
    return <OrchestrateMini />;
  },
});

// A packaged build loads the renderer over file://, which has no origin for the History
// API to push against. Hash history is the one mode that behaves the same there as it
// does against the dev server.
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    profileRoute,
    billingRoute,
    settingsRoute,
    devLogsRoute,
    miniTavernRoute,
    orchestrateMiniRoute,
  ]),
  history: createHashHistory(),
  // Every route's render errors land here; main.tsx's AppErrorBoundary covers what sits outside.
  defaultErrorComponent: ({ error }) => <AppErrorFallback error={error} />,
  defaultOnCatch: (error, info) => reportRenderError(error, info.componentStack),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
