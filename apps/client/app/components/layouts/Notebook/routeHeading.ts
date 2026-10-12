/**
 * Text for the visually hidden h1 the notebook layout gives a screen that has no visible one, or
 * null for a screen that renders its own h1 (or is not listed). Keyed by first path segment,
 * except /projects, which routeHeading special-cases. A screen that gains a visible h1 must
 * leave this list so it does not end up with two.
 */
const HEADINGS: Record<string, string> = {
  '': 'New chat',
  new: 'New chat',
  notebooks: 'Chat',
  profile: 'Profile',
  skills: 'Skills',
  organizations: 'Teams',
  agents: 'Agents',
  'agent-executions': 'Agent executions',
  'data-lakes': 'Data lakes',
  gears: 'Gears',
  feedback: 'Your feedback',
  billing: 'Billing',
  share: 'Shared notebook',
  studio: 'Studio',
  hearth: 'Hearth',
  'deep-agents': 'Deep agents',
  report: 'Report',
  'quests-v5': 'Quests',
  hud: 'The Keep',
};

export const routeHeading = (pathname: string): string | null => {
  const [segment = '', ...rest] = pathname.split('/').filter(Boolean);
  // The /projects list shows its own h1; a single project's page has only a breadcrumb.
  if (segment === 'projects') return rest.length > 0 ? 'Project' : null;
  return Object.prototype.hasOwnProperty.call(HEADINGS, segment) ? HEADINGS[segment] : null;
};
