import { describe, it, expect } from 'vitest';
import { resolveRouteHelpSuggestion, ROUTE_HELP_SUGGESTIONS, type RouteHelpSuggestion } from './routeHelpSuggestions';

describe('resolveRouteHelpSuggestion', () => {
  const fixtures: RouteHelpSuggestion[] = [
    { path: '/agents', helpIds: ['features/agents'], label: 'Agents' },
    { path: '/agents/new', helpIds: ['features/agents-create'], label: 'Create Agent' },
    { path: '/projects', helpIds: ['features/projects'], label: 'Projects' },
  ];

  it('matches an exact pathname', () => {
    expect(resolveRouteHelpSuggestion('/projects', fixtures)?.helpIds).toEqual(['features/projects']);
  });

  it('matches a sub-path of a mapped route', () => {
    expect(resolveRouteHelpSuggestion('/projects/abc123', fixtures)?.label).toBe('Projects');
  });

  it('prefers the longest-prefix match', () => {
    expect(resolveRouteHelpSuggestion('/agents/new', fixtures)?.helpIds).toEqual(['features/agents-create']);
  });

  it('returns null when no route maps to help content', () => {
    expect(resolveRouteHelpSuggestion('/settings', fixtures)).toBeNull();
  });

  it('does not treat a partial segment as a match', () => {
    // '/agents-archive' must NOT match '/agents' - startsWith is segment-aware ('/agents/').
    expect(resolveRouteHelpSuggestion('/agents-archive', fixtures)).toBeNull();
  });

  it('ships a non-empty default mapping with valid entries', () => {
    expect(ROUTE_HELP_SUGGESTIONS.length).toBeGreaterThan(0);
    for (const entry of ROUTE_HELP_SUGGESTIONS) {
      expect(entry.path.startsWith('/')).toBe(true);
      expect(entry.helpIds.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });
});
