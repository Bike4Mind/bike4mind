import { useLocation } from '@tanstack/react-router';
import { resolveRouteHelpSuggestion, type RouteHelpSuggestion } from '@client/app/components/help/routeHelpSuggestions';

/**
 * Returns the context-aware help suggestion for the current route, or `null` when the route has no
 * associated help content. Reads the live pathname from Tanstack Router so it updates on navigation.
 */
export function useRouteHelpSuggestions(): RouteHelpSuggestion | null {
  const { pathname } = useLocation();
  return resolveRouteHelpSuggestion(pathname);
}
