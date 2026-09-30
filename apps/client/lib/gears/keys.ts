/**
 * Every gear key, shared by the client, the status and claim endpoints and the
 * presentation copy. The catalog (server/services/gears/catalog.ts) must define exactly these,
 * and GEAR_PRESENTATION is typed by them - a gear added here without its copy or its
 * definition fails to compile or fails the catalog parity test.
 */
export const GEAR_KEYS = [
  // destinations (features with a sidenav row of their own)
  'projects',
  'agents',
  'datalakes',
  'files',
  'published',
  'hearth',
  // skills (achievements - no nav effect)
  'apikey',
  'apicall',
  'image',
  'voice',
  'models',
  'react',
  'python',
  'shareproject',
  'questmaster',
  'mementos',
  'video',
  'music',
  'sound',
  'mcp',
  'mfa',
  'slack',
  'importopenai',
  'importclaude',
  'research',
  'rapidreply',
  'shareagent',
  'downloadnotebook',
  'forknotebook',
  'websearch',
  'webfetch',
  'wolfram',
  'matheval',
  'clidocs',
] as const;

export type GearKey = (typeof GEAR_KEYS)[number];

/** Destinations are features with a sidenav row of their own; skills are done inside them. */
export type GearKind = 'destination' | 'skill';
