import { createHashHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Placeholder } from './routes/Placeholder';

const rootRoute = createRootRoute();

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Placeholder,
});

// A packaged build loads the renderer over file://, which has no origin for the History
// API to push against. Hash history is the one mode that behaves the same there as it
// does against the dev server.
export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  history: createHashHistory(),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
