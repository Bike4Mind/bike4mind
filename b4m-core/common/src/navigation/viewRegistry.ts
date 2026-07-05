/**
 * View Registry - Static manifest of navigable views across the app.
 * Used by the navigate_view LLM tool to suggest contextual navigation.
 */

export type NavigationType = 'route' | 'tab' | 'action';
export type ViewSection = 'opti' | 'admin' | 'global';

export interface NavigableView {
  /** Unique key like "opti.scheduling", "admin.users" */
  id: string;
  /** Which app section this view belongs to */
  section: ViewSection;
  /** Button text shown to user */
  label: string;
  /** Description for the LLM to understand when to suggest this view */
  description: string;
  /** How navigation is executed client-side */
  navigationType: NavigationType;
  /** Route path, tab index, or action string */
  target: string;
  /** Keywords to help the LLM match intent */
  keywords: string[];
  /** Only show to admin users */
  requiresAdmin?: boolean;
}

/** Resolved navigation intent stored on the quest and sent to the client */
export interface NavigationIntent {
  viewId: string;
  label: string;
  description: string;
  navigationType: NavigationType;
  target: string;
  reason: string;
}

// View Registry Data

export const VIEW_REGISTRY: NavigableView[] = [
  // ── OptiHashi (Optimizer) ──────────────────────────────────────────────
  {
    id: 'opti.root',
    section: 'opti',
    label: 'OptiHashi Home',
    description: 'The OptiHashi Optimizer landing page showing all 8 pattern family cards',
    navigationType: 'route',
    target: '/opti',
    keywords: ['optimization', 'canvasser', 'home', 'patterns', 'families'],
  },
  {
    id: 'opti.scheduling',
    section: 'opti',
    label: 'Scheduling',
    description: 'Scheduling optimization: job-shop, flow-shop, shift scheduling, makespan minimization',
    navigationType: 'action',
    target: 'scheduling',
    keywords: ['scheduling', 'job-shop', 'flow-shop', 'shifts', 'makespan', 'calendar'],
  },
  {
    id: 'opti.scheduling.problem',
    section: 'opti',
    label: 'Problem Editor',
    description: 'Define and preview scheduling problems — job-shop matrix encoding',
    navigationType: 'action',
    target: 'scheduling.problem',
    keywords: ['problem', 'editor', 'matrix', 'jobs', 'machines', 'operations', 'custom problem'],
  },
  {
    id: 'opti.scheduling.solvers',
    section: 'opti',
    label: 'Solver Selection',
    description: 'Configure which solvers to race across a range of optimization strategies',
    navigationType: 'action',
    target: 'scheduling.solvers',
    keywords: ['solvers', 'greedy', 'solver race', 'configure solvers', 'optimization strategies'],
  },
  {
    id: 'opti.scheduling.results',
    section: 'opti',
    label: 'Race Results',
    description: 'View solver race results — progress, best schedule, makespan comparison, utilization',
    navigationType: 'action',
    target: 'scheduling.results',
    keywords: [
      'results',
      'race results',
      'makespan',
      'comparison',
      'best schedule',
      'utilization',
      'solver comparison',
    ],
  },
  {
    id: 'opti.scheduling.gantt',
    section: 'opti',
    label: 'Gantt Chart',
    description: 'Gantt chart visualization of the best scheduling solution',
    navigationType: 'action',
    target: 'scheduling.gantt',
    keywords: ['gantt', 'chart', 'visualization', 'timeline', 'schedule view'],
  },
  {
    id: 'opti.scheduling.qwork',
    section: 'opti',
    label: 'Q/Work',
    description: 'View job history and status from the compute service',
    navigationType: 'action',
    target: 'scheduling.qwork',
    keywords: ['hardware', 'compute', 'jobs', 'status', 'history'],
  },
  {
    id: 'opti.routing',
    section: 'opti',
    label: 'Routing',
    description: 'Vehicle routing, TSP, logistics, delivery routes, fleet management',
    navigationType: 'action',
    target: 'routing',
    keywords: ['routing', 'TSP', 'vehicle', 'logistics', 'delivery', 'fleet', 'path'],
  },
  {
    id: 'opti.packing',
    section: 'opti',
    label: 'Packing',
    description: 'Bin packing, knapsack, container loading, space optimization',
    navigationType: 'action',
    target: 'packing',
    keywords: ['packing', 'bin', 'knapsack', 'container', 'loading', 'space'],
  },
  {
    id: 'opti.network',
    section: 'opti',
    label: 'Network Design',
    description: 'Network flow, facility location, supply chain network design',
    navigationType: 'action',
    target: 'network',
    keywords: ['network', 'flow', 'facility', 'location', 'supply chain', 'graph'],
  },
  {
    id: 'opti.selection',
    section: 'opti',
    label: 'Selection',
    description: 'Portfolio selection, feature selection, subset optimization',
    navigationType: 'action',
    target: 'selection',
    keywords: ['selection', 'portfolio', 'feature', 'subset', 'pick', 'choose'],
  },
  {
    id: 'opti.economic',
    section: 'opti',
    label: 'Economic',
    description: 'Resource allocation, pricing, budgeting, economic optimization',
    navigationType: 'action',
    target: 'economic',
    keywords: ['economic', 'resource', 'allocation', 'pricing', 'budget', 'cost'],
  },
  {
    id: 'opti.assignment',
    section: 'opti',
    label: 'Assignment',
    description: 'Task assignment, matching, workforce allocation, team formation',
    navigationType: 'action',
    target: 'assignment',
    keywords: ['assignment', 'matching', 'workforce', 'team', 'allocate', 'assign'],
  },
  {
    id: 'opti.partitioning',
    section: 'opti',
    label: 'Partitioning',
    description: 'Graph partitioning, clustering, load balancing, data partitioning',
    navigationType: 'action',
    target: 'partitioning',
    keywords: ['partitioning', 'clustering', 'balancing', 'partition', 'divide', 'split'],
  },

  // ── Admin ──────────────────────────────────────────────────────────────
  {
    id: 'admin.users',
    section: 'admin',
    label: 'User Management',
    description: 'View and manage user accounts, roles, and permissions',
    navigationType: 'tab',
    target: '0', // AdminTab.Users
    keywords: ['users', 'accounts', 'roles', 'permissions', 'manage users'],
    requiresAdmin: true,
  },
  {
    id: 'admin.credit_analytics',
    section: 'admin',
    label: 'Credit Analytics',
    description: 'View credit usage, add credits to users, billing analytics',
    navigationType: 'tab',
    target: '15', // AdminTab.CreditAnalytics
    keywords: ['credits', 'billing', 'usage', 'add credits', 'balance', 'cost'],
    requiresAdmin: true,
  },
  {
    id: 'admin.settings',
    section: 'admin',
    label: 'Admin Settings',
    description: 'System-wide administration settings and configuration',
    navigationType: 'tab',
    target: '1', // AdminTab.AdminSettings
    keywords: ['settings', 'configuration', 'admin', 'system settings'],
    requiresAdmin: true,
  },
  {
    id: 'admin.system_health',
    section: 'admin',
    label: 'System Health',
    description: 'Monitor system health, uptime, and performance metrics',
    navigationType: 'tab',
    target: '29', // AdminTab.SystemHealth
    keywords: ['health', 'uptime', 'monitoring', 'performance', 'status'],
    requiresAdmin: true,
  },
  {
    id: 'admin.llm_dashboard',
    section: 'admin',
    label: 'LLM Dashboard',
    description: 'LLM model usage, costs, and performance monitoring',
    navigationType: 'tab',
    target: '24', // AdminTab.LLMDashboard
    keywords: ['llm', 'model', 'ai', 'costs', 'tokens', 'dashboard'],
    requiresAdmin: true,
  },
  {
    id: 'admin.tool_definitions',
    section: 'admin',
    label: 'Tool Definitions',
    description: 'Manage LLM tool definitions and configurations',
    navigationType: 'tab',
    target: '31', // AdminTab.ToolDefinitions
    keywords: ['tools', 'tool definitions', 'functions', 'capabilities'],
    requiresAdmin: true,
  },
  {
    id: 'admin.organizations',
    section: 'admin',
    label: 'Organizations',
    description: 'Manage organizations, teams, and multi-tenant settings',
    navigationType: 'tab',
    target: '14', // AdminTab.Organizations
    keywords: ['organizations', 'teams', 'tenants', 'companies'],
    requiresAdmin: true,
  },
  {
    id: 'admin.analytics',
    section: 'admin',
    label: 'Analytics',
    description: 'User activity analytics, engagement metrics, and reports',
    navigationType: 'tab',
    target: '3', // AdminTab.Analytics
    keywords: ['analytics', 'metrics', 'reports', 'engagement', 'activity'],
    requiresAdmin: true,
  },
  {
    id: 'admin.subscribers',
    section: 'admin',
    label: 'Subscribers',
    description: 'Manage subscriber waitlist and access approvals',
    navigationType: 'tab',
    target: '12', // AdminTab.Subscribers
    keywords: ['subscribers', 'waitlist', 'approvals', 'signups'],
    requiresAdmin: true,
  },
  {
    id: 'admin.subscriptions',
    section: 'admin',
    label: 'Subscriptions',
    description: 'Manage subscription plans, tiers, and billing',
    navigationType: 'tab',
    target: '13', // AdminTab.Subscriptions
    keywords: ['subscriptions', 'plans', 'tiers', 'billing', 'pricing'],
    requiresAdmin: true,
  },
  {
    id: 'admin.invite_codes',
    section: 'admin',
    label: 'Invite Codes',
    description: 'Create and manage registration invite codes',
    navigationType: 'tab',
    target: '5', // AdminTab.RegistrationInvites
    keywords: ['invite', 'codes', 'registration', 'invitations'],
    requiresAdmin: true,
  },
  {
    id: 'admin.agent_ops',
    section: 'admin',
    label: 'Agent Operations',
    description: 'Monitor and manage AI agent operations and tasks',
    navigationType: 'tab',
    target: '23', // AdminTab.AgentOps
    keywords: ['agents', 'operations', 'tasks', 'agent ops'],
    requiresAdmin: true,
  },
  {
    id: 'admin.security_dashboard',
    section: 'admin',
    label: 'Security Dashboard',
    description: 'Security monitoring, threat detection, and audit logs',
    navigationType: 'tab',
    target: '26', // AdminTab.SecurityDashboard
    keywords: ['security', 'threats', 'audit', 'logs', 'vulnerabilities'],
    requiresAdmin: true,
  },
  {
    id: 'admin.system_prompts',
    section: 'admin',
    label: 'System Prompts',
    description: 'Edit and manage system prompts for AI models',
    navigationType: 'tab',
    target: '21', // AdminTab.SystemPrompts
    keywords: ['prompts', 'system prompts', 'instructions', 'AI prompts'],
    requiresAdmin: true,
  },
  {
    id: 'admin.modals',
    section: 'admin',
    label: 'Modals',
    description: 'Manage modal dialogs and popup configurations',
    navigationType: 'tab',
    target: '7', // AdminTab.Modals
    keywords: ['modals', 'dialogs', 'popups', 'announcements'],
    requiresAdmin: true,
  },
  {
    id: 'admin.whats_new',
    section: 'admin',
    label: 'What&apos;s New',
    description: 'Manage What&apos;s New release notes and changelogs',
    navigationType: 'tab',
    target: '32', // AdminTab.WhatsNewModals
    keywords: ['whats new', 'release notes', 'changelog', 'updates'],
    requiresAdmin: true,
  },
  {
    id: 'admin.rapid_reply',
    section: 'admin',
    label: 'Rapid Reply',
    description: 'Configure rapid reply templates and shortcuts',
    navigationType: 'tab',
    target: '25', // AdminTab.RapidReply
    keywords: ['rapid reply', 'templates', 'shortcuts', 'quick responses'],
    requiresAdmin: true,
  },
  {
    id: 'admin.slack_workspaces',
    section: 'admin',
    label: 'Slack Workspaces',
    description: 'Manage connected Slack workspace integrations',
    navigationType: 'tab',
    target: '30', // AdminTab.SlackWorkspaces
    keywords: ['slack', 'workspaces', 'integrations', 'messaging'],
    requiresAdmin: true,
  },
  {
    id: 'admin.secrets_rotation',
    section: 'admin',
    label: 'Secrets Rotation',
    description: 'Manage API key rotation and secret lifecycle',
    navigationType: 'tab',
    target: '16', // AdminTab.SecretsRotation
    keywords: ['secrets', 'rotation', 'API keys', 'credentials'],
    requiresAdmin: true,
  },
  {
    id: 'admin.bulk_import',
    section: 'admin',
    label: 'Bulk Import',
    description: 'Bulk import users and data from CSV or other formats',
    navigationType: 'tab',
    target: '17', // AdminTab.BulkImport
    keywords: ['bulk', 'import', 'CSV', 'migration', 'data import'],
    requiresAdmin: true,
  },
  {
    id: 'admin.feedbacks',
    section: 'admin',
    label: 'Feedbacks',
    description: 'View and manage user feedback, bug reports, and feature requests',
    navigationType: 'tab',
    target: '2', // AdminTab.Feedbacks
    keywords: ['feedback', 'bug reports', 'feature requests', 'user feedback', 'complaints'],
    requiresAdmin: true,
  },
  {
    id: 'admin.files',
    section: 'admin',
    label: 'Files',
    description: 'Manage uploaded files across all users, storage analytics',
    navigationType: 'tab',
    target: '8', // AdminTab.Files
    keywords: ['files', 'uploads', 'storage', 'documents', 'file management'],
    requiresAdmin: true,
  },
  {
    id: 'admin.documentation',
    section: 'admin',
    label: 'Documentation',
    description: 'System documentation and internal reference guides',
    navigationType: 'tab',
    target: '9', // AdminTab.Documentation
    keywords: ['documentation', 'docs', 'guides', 'reference', 'help docs'],
    requiresAdmin: true,
  },
  {
    id: 'admin.world_time',
    section: 'admin',
    label: 'World Time',
    description: 'View current time across multiple time zones',
    navigationType: 'tab',
    target: '10', // AdminTab.WorldTime
    keywords: ['world time', 'time zones', 'clocks', 'UTC', 'international time'],
    requiresAdmin: true,
  },
  {
    id: 'admin.model_logs',
    section: 'admin',
    label: 'Model Logs',
    description: 'View LLM model request/response logs and debugging information',
    navigationType: 'tab',
    target: '18', // AdminTab.ModelLogs
    keywords: ['model logs', 'LLM logs', 'request logs', 'debugging', 'API logs'],
    requiresAdmin: true,
  },
  {
    id: 'admin.model_metrics',
    section: 'admin',
    label: 'Model Metrics',
    description: 'LLM model performance metrics, latency, and usage statistics',
    navigationType: 'tab',
    target: '19', // AdminTab.ModelMetrics
    keywords: ['model metrics', 'performance', 'latency', 'tokens', 'model usage'],
    requiresAdmin: true,
  },
  {
    id: 'admin.event_metrics',
    section: 'admin',
    label: 'Event Metrics',
    description: 'Track system events, user activity events, and event analytics',
    navigationType: 'tab',
    target: '20', // AdminTab.EventMetrics
    keywords: ['event metrics', 'events', 'activity tracking', 'event analytics'],
    requiresAdmin: true,
  },
  {
    id: 'admin.identity_providers',
    section: 'admin',
    label: 'Identity Providers',
    description: 'Configure SSO, SAML, and identity provider integrations',
    navigationType: 'tab',
    target: '22', // AdminTab.IdentityProviders
    keywords: ['identity', 'SSO', 'SAML', 'providers', 'authentication', 'login providers'],
    requiresAdmin: true,
  },
  {
    id: 'admin.email_verification',
    section: 'admin',
    label: 'Email Verification',
    description: 'Manage email verification status and send verification emails',
    navigationType: 'tab',
    target: '27', // AdminTab.EmailVerification
    keywords: ['email', 'verification', 'verify email', 'email status'],
    requiresAdmin: true,
  },
  {
    id: 'admin.team',
    section: 'admin',
    label: 'Team',
    description: 'Manage team members, roles, and team settings',
    navigationType: 'tab',
    target: '28', // AdminTab.Team
    keywords: ['team', 'members', 'roles', 'team management', 'staff'],
    requiresAdmin: true,
  },
  {
    id: 'admin.slack_metrics',
    section: 'admin',
    label: 'Slack Metrics',
    description: 'Slack integration usage metrics and message analytics',
    navigationType: 'tab',
    target: '33', // AdminTab.SlackMetrics
    keywords: ['slack metrics', 'slack usage', 'message analytics', 'slack stats'],
    requiresAdmin: true,
  },
  {
    id: 'admin.system_secrets',
    section: 'admin',
    label: 'System Secrets',
    description: 'View and manage system-level secrets and environment variables',
    navigationType: 'tab',
    target: '34', // AdminTab.SystemSecrets
    keywords: ['system secrets', 'environment variables', 'env vars', 'secrets', 'configuration'],
    requiresAdmin: true,
  },
  {
    id: 'admin.liveops_triage',
    section: 'admin',
    label: 'LiveOps Triage',
    description: 'Real-time error triage, production issue monitoring, and incident response',
    navigationType: 'tab',
    target: '35', // AdminTab.LiveOpsTriage
    keywords: ['liveops', 'triage', 'errors', 'incidents', 'production issues', 'monitoring'],
    requiresAdmin: true,
  },

  // ── Global ─────────────────────────────────────────────────────────────
  {
    id: 'global.chat',
    section: 'global',
    label: 'Chat',
    description: 'Main AI chat interface for conversations',
    navigationType: 'route',
    target: '/',
    keywords: ['chat', 'conversation', 'talk', 'message', 'ask'],
  },
  {
    id: 'global.projects',
    section: 'global',
    label: 'Projects',
    description: 'View and manage projects and workspaces',
    navigationType: 'route',
    target: '/projects',
    keywords: ['projects', 'workspaces', 'organize', 'folders'],
  },
  {
    id: 'global.agents',
    section: 'global',
    label: 'Agents',
    description: 'Browse and configure AI agents',
    navigationType: 'route',
    target: '/agents',
    keywords: ['agents', 'AI assistants', 'bots', 'configure agents'],
  },
  {
    id: 'global.agents_create',
    section: 'global',
    label: 'Create Agent',
    description: 'Create a new AI agent with personality, motivation, system prompt, and capabilities',
    navigationType: 'route',
    target: '/agents/new',
    keywords: ['create agent', 'new agent', 'build agent', 'agent personality', 'agent motivation', 'agent setup'],
  },
  {
    id: 'global.profile',
    section: 'global',
    label: 'Profile',
    description: 'User profile settings and preferences',
    navigationType: 'route',
    target: '/profile',
    keywords: ['profile', 'account', 'preferences', 'personal settings'],
  },
  {
    id: 'global.profile_security',
    section: 'global',
    label: 'Security Settings',
    description: 'MFA, password, and security settings for your account',
    navigationType: 'route',
    target: '/profile/security',
    keywords: ['security', 'MFA', 'password', 'two-factor', '2FA'],
  },
  {
    id: 'global.profile_api_keys',
    section: 'global',
    label: 'API Keys',
    description: 'Manage your personal API keys for integrations',
    navigationType: 'route',
    target: '/profile/api-keys',
    keywords: ['API keys', 'tokens', 'integrations', 'developer'],
  },
  {
    id: 'global.admin',
    section: 'global',
    label: 'Admin Panel',
    description: 'Admin dashboard for system management',
    navigationType: 'route',
    target: '/admin',
    keywords: ['admin', 'dashboard', 'management', 'administration'],
    requiresAdmin: true,
  },
  {
    id: 'global.help',
    section: 'global',
    label: 'Help',
    description: 'Help documentation and support resources',
    navigationType: 'route',
    target: '/help',
    keywords: ['help', 'support', 'documentation', 'FAQ', 'guide'],
  },
  {
    id: 'global.knowledge_base',
    section: 'global',
    label: 'Knowledge Base',
    description: 'Browse uploaded files and documents in your knowledge base',
    navigationType: 'action',
    target: 'file_browser',
    keywords: ['knowledge', 'files', 'documents', 'uploads', 'library'],
  },
  {
    id: 'global.settings',
    section: 'global',
    label: 'Settings',
    description: 'Application settings and preferences',
    navigationType: 'route',
    target: '/settings',
    keywords: ['settings', 'preferences', 'configuration', 'options'],
  },
];

// Helpers

/** Look up a view by its ID. */
export function getViewById(viewId: string): NavigableView | undefined {
  return VIEW_REGISTRY.find(v => v.id === viewId);
}

/**
 * Filter views by section and admin status.
 */
export function getFilteredViews(options?: { section?: ViewSection; isAdmin?: boolean }): NavigableView[] {
  return VIEW_REGISTRY.filter(v => {
    if (options?.section && v.section !== options.section) return false;
    if (v.requiresAdmin && !options?.isAdmin) return false;
    return true;
  });
}

/**
 * Generate a compact text summary of available views for the LLM system prompt.
 * Keeps output small (~200 tokens) so it doesn't bloat the context.
 */
export function getViewSummaryForLLM(options?: { section?: ViewSection; isAdmin?: boolean }): string {
  const views = getFilteredViews(options);

  const grouped: Record<string, string[]> = {};
  for (const v of views) {
    const key = v.section.toUpperCase();
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(`- ${v.id}: ${v.label} — ${v.description}`);
  }

  const sections = Object.entries(grouped)
    .map(([section, lines]) => `[${section}]\n${lines.join('\n')}`)
    .join('\n\n');

  return [
    '# navigate_view Tool Usage',
    '',
    'You have a navigate_view tool that renders clickable navigation buttons in your response.',
    '',
    'When the user is clearly asking about a feature that maps to one of the views below,',
    'call navigate_view alongside your text answer so they see a clickable button.',
    'Only call it when the match is obvious and useful — skip it for general questions, small talk,',
    'or topics unrelated to the views listed. Do not force a navigation suggestion onto every turn.',
    '',
    'Example — if the user asks "how do I configure solvers":',
    '1. Call navigate_view with suggestions: [{viewId: "opti.scheduling.solvers", reason: "Configure solvers here"}]',
    '2. AND write your text answer',
    '',
    sections,
  ].join('\n');
}

/**
 * Top-level path prefixes for views that are first-class routes - derived from
 * VIEW_REGISTRY so this list never drifts from the registered views. Excludes
 * the main chat page (`/`) since it isn't a "feature page" for navigation
 * suggestions, and tab/action views since they don't have their own path.
 *
 * `/profile/security` and `/profile/api-keys` both collapse to `/profile`.
 */
export const FEATURE_PATH_PREFIXES: readonly string[] = Array.from(
  new Set(
    VIEW_REGISTRY.filter(v => v.navigationType === 'route' && v.target.startsWith('/') && v.target !== '/').map(v => {
      const [, top] = v.target.split('/');
      return `/${top}`;
    })
  )
);

/**
 * Extract the user's current path from the `[Current View Context]` system
 * message that the client injects (see apps/client/app/utils/sessionsAPICalls.ts).
 * Returns null when no context message is present or the marker can't be parsed.
 */
export function getCurrentPathFromContext(messages: ReadonlyArray<{ content: unknown }> | undefined): string | null {
  if (!messages?.length) return null;
  const ctx = messages.find(m => typeof m.content === 'string' && m.content.includes('[Current View Context]'));
  if (!ctx || typeof ctx.content !== 'string') return null;
  return ctx.content.match(/Path:\s*(\S+)/)?.[1] ?? null;
}

/**
 * True when `path` corresponds to a registered feature page where navigation
 * suggestions are actually useful. On the main chat page (`/`) or unknown
 * paths the navigate_view tool is pure overhead. Uses strict boundary matching
 * so `/admin-emergency` does not match the `/admin` prefix.
 */
export function isNavigableFeaturePath(path: string | null | undefined): boolean {
  if (!path) return false;
  return FEATURE_PATH_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Resolve an array of viewIds + reasons into hydrated NavigationIntents.
 * Skips unknown IDs and respects admin filtering.
 */
export function resolveNavigationIntents(
  suggestions: Array<{ viewId: string; reason: string }>,
  isAdmin?: boolean
): NavigationIntent[] {
  return suggestions
    .map(s => {
      const view = getViewById(s.viewId);
      if (!view) return null;
      if (view.requiresAdmin && !isAdmin) return null;
      return {
        viewId: view.id,
        label: view.label,
        description: view.description,
        navigationType: view.navigationType,
        target: view.target,
        reason: s.reason,
      };
    })
    .filter((intent): intent is NavigationIntent => intent !== null);
}
