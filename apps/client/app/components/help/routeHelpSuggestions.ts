/**
 * Central route -> help-article mapping for context-aware help suggestions.
 *
 * Declarative mapping so suggestions can be surfaced automatically from the current route, with no
 * embedding/LLM round-trip (deterministic and easy to test).
 *
 * Matching is longest-prefix over the pathname, so a more specific route wins over a less specific
 * one (e.g. `/agents/new` overrides `/agents`).
 */

export interface RouteHelpSuggestion {
  /** Route path prefix matched against `useLocation().pathname`. */
  path: string;
  /** Help article slugs to suggest, most relevant first. */
  helpIds: string[];
  /** Short, human-readable reason shown in the suggestion surface. */
  label: string;
}

/**
 * Seeded from the routes that already place a `ContextHelpButton` with an explicit `helpId`, so the
 * suggested articles are known-good slugs. Extend this list as new routes gain help content.
 */
export const ROUTE_HELP_SUGGESTIONS: RouteHelpSuggestion[] = [
  { path: '/projects', helpIds: ['features/projects'], label: 'Learn about Projects' },
  { path: '/agents', helpIds: ['features/agents'], label: 'Learn about AI Agents' },
  {
    path: '/organizations',
    helpIds: ['features/organizations-teams'],
    label: 'Learn about Organizations & Teams',
  },
  { path: '/quests', helpIds: ['features/quest-master'], label: 'Learn about Quest Master' },
];

/**
 * Resolve the best help suggestion for a pathname via longest-prefix match.
 * Returns `null` when no route maps to help content.
 */
export function resolveRouteHelpSuggestion(
  pathname: string,
  suggestions: RouteHelpSuggestion[] = ROUTE_HELP_SUGGESTIONS
): RouteHelpSuggestion | null {
  let best: RouteHelpSuggestion | null = null;
  for (const suggestion of suggestions) {
    const isMatch = pathname === suggestion.path || pathname.startsWith(suggestion.path + '/');
    if (isMatch && (!best || suggestion.path.length > best.path.length)) {
      best = suggestion;
    }
  }
  return best;
}
