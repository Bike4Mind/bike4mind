import { createHashHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { DevLogsWindow } from './devlog/DevLogsWindow';
import { Home } from './routes/Home';
import { Profile } from './routes/Profile';

const rootRoute = createRootRoute();

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

// Its own window, opened by a chord rather than navigated to from the app: see
// main/devlog/window.ts. A route rather than a second html entry so it inherits the same
// bundle, theme and preload bridge.
const devLogsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dev-logs',
  component: DevLogsWindow,
});

// A packaged build loads the renderer over file://, which has no origin for the History
// API to push against. Hash history is the one mode that behaves the same there as it
// does against the dev server.
export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, profileRoute, devLogsRoute]),
  history: createHashHistory(),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
