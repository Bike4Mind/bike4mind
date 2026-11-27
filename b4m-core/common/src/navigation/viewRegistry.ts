/**
 * View Registry - Static manifest of navigable views across the app.
 * Used by the navigate_view LLM tool to suggest contextual navigation.
 */

import { OPTI_SURFACE } from '../surfaces';

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
  /**
   * Workspace surface an `action` view leads into, when it is not part of the main app. Registered
   * workspace ids come from `WORKSPACE_SURFACES`; the client uses this to tell whether a suggested
   * action opens a workspace the user hid.
   */
  surface?: string;
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
    surface: OPTI_SURFACE,
    label: 'OptiHashi Home',
    description: 'The OptiHashi Optimizer landing page showing the pattern family cards',
    navigationType: 'route',
    target: '/opti',
    keywords: ['optimization', 'canvasser', 'home', 'patterns', 'families'],
  },
  {
    id: 'opti.scheduling',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Scheduling',
    description: 'Scheduling optimization: job-shop, flow-shop, shift scheduling, makespan minimization',
    navigationType: 'action',
    target: 'scheduling',
    keywords: ['scheduling', 'job-shop', 'flow-shop', 'shifts', 'makespan', 'calendar'],
  },
  {
    id: 'opti.scheduling.problem',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Scheduling Problem',
    description: 'Define and preview scheduling problems — job-shop matrix encoding',
    navigationType: 'action',
    target: 'scheduling.problem',
    keywords: ['problem', 'editor', 'matrix', 'jobs', 'machines', 'operations', 'custom problem'],
  },
  {
    id: 'opti.scheduling.solvers',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Scheduling Solvers',
    description: 'Configure which solvers to race across a range of optimization strategies',
    navigationType: 'action',
    target: 'scheduling.solvers',
    keywords: ['solvers', 'greedy', 'solver race', 'configure solvers', 'optimization strategies'],
  },
  {
    id: 'opti.scheduling.results',
    section: 'opti',
    surface: OPTI_SURFACE,
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
    surface: OPTI_SURFACE,
    label: 'Gantt Chart',
    description: 'Gantt chart visualization of the best scheduling solution',
    navigationType: 'action',
    target: 'scheduling.gantt',
    keywords: ['gantt', 'chart', 'visualization', 'timeline', 'schedule view'],
  },
  {
    id: 'opti.scheduling.qwork',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Q/Work',
    description: 'View job history and status from the compute service',
    navigationType: 'action',
    target: 'scheduling.qwork',
    keywords: ['hardware', 'compute', 'jobs', 'status', 'history'],
  },
  {
    id: 'opti.routing',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Routing',
    description: 'Vehicle routing, TSP, logistics, delivery routes, fleet management',
    navigationType: 'action',
    target: 'routing',
    keywords: ['routing', 'TSP', 'vehicle', 'logistics', 'delivery', 'fleet', 'path'],
  },
  {
    id: 'opti.routing.problem',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Routing Problem',
    description: 'Define and preview routing problems: stops, vehicles, distances',
    navigationType: 'action',
    target: 'routing.problem',
    keywords: ['routing problem', 'stops', 'depot', 'vehicles', 'distances', 'route editor'],
  },
  {
    id: 'opti.routing.solvers',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Routing Solvers',
    description: 'Choose which solvers to race on the routing problem',
    navigationType: 'action',
    target: 'routing.solvers',
    keywords: ['routing solvers', 'TSP solvers', 'route solvers', 'configure solvers', 'solver race'],
  },
  {
    id: 'opti.packing',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Packing',
    description: 'Bin packing, knapsack, container loading, space optimization',
    navigationType: 'action',
    target: 'packing',
    keywords: ['packing', 'bin', 'knapsack', 'container', 'loading', 'space'],
  },
  {
    id: 'opti.packing.problem',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Packing Problem',
    description: 'Define and preview packing problems: items, bins, capacities',
    navigationType: 'action',
    target: 'packing.problem',
    keywords: ['packing problem', 'items', 'bins', 'capacity', 'knapsack editor', 'container'],
  },
  {
    id: 'opti.packing.solvers',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Packing Solvers',
    description: 'Choose which solvers to race on the packing problem',
    navigationType: 'action',
    target: 'packing.solvers',
    keywords: ['packing solvers', 'bin packing solvers', 'knapsack solvers', 'configure solvers', 'solver race'],
  },
  {
    id: 'opti.network',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Network Design',
    description: 'Network flow, facility location, supply chain network design',
    navigationType: 'action',
    target: 'network',
    keywords: ['network', 'flow', 'facility', 'location', 'supply chain', 'graph'],
  },
  {
    id: 'opti.network.problem',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Network Problem',
    description: 'Define and preview network design problems: nodes, edges, facilities',
    navigationType: 'action',
    target: 'network.problem',
    keywords: ['network problem', 'nodes', 'edges', 'facilities', 'supply chain editor', 'graph'],
  },
  {
    id: 'opti.network.solvers',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Network Solvers',
    description: 'Choose which solvers to race on the network design problem',
    navigationType: 'action',
    target: 'network.solvers',
    keywords: ['network solvers', 'flow solvers', 'facility solvers', 'configure solvers', 'solver race'],
  },
  {
    id: 'opti.selection',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Selection',
    description: 'Portfolio selection, feature selection, subset optimization',
    navigationType: 'action',
    target: 'selection',
    keywords: ['selection', 'portfolio', 'feature', 'subset', 'pick', 'choose'],
  },
  {
    id: 'opti.selection.problem',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Selection Problem',
    description: 'Define and preview selection problems: candidates, values, constraints',
    navigationType: 'action',
    target: 'selection.problem',
    keywords: ['selection problem', 'candidates', 'portfolio editor', 'subset', 'values', 'constraints'],
  },
  {
    id: 'opti.selection.solvers',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Selection Solvers',
    description: 'Choose which solvers to race on the selection problem',
    navigationType: 'action',
    target: 'selection.solvers',
    keywords: ['selection solvers', 'portfolio solvers', 'subset solvers', 'configure solvers', 'solver race'],
  },
  {
    id: 'opti.economic',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Economic',
    description: 'Resource allocation, pricing, budgeting, economic optimization',
    navigationType: 'action',
    target: 'economic',
    keywords: ['economic', 'resource', 'allocation', 'pricing', 'budget', 'cost'],
  },
  {
    id: 'opti.economic.problem',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Economic Problem',
    description: 'Define and preview economic problems: resources, prices, budgets',
    navigationType: 'action',
    target: 'economic.problem',
    keywords: ['economic problem', 'resources', 'prices', 'budget editor', 'allocation', 'costs'],
  },
  {
    id: 'opti.economic.solvers',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Economic Solvers',
    description: 'Choose which solvers to race on the economic problem',
    navigationType: 'action',
    target: 'economic.solvers',
    keywords: ['economic solvers', 'allocation solvers', 'pricing solvers', 'configure solvers', 'solver race'],
  },
  {
    id: 'opti.assignment',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Assignment',
    description: 'Task assignment, matching, workforce allocation, team formation',
    navigationType: 'action',
    target: 'assignment',
    keywords: ['assignment', 'matching', 'workforce', 'team', 'allocate', 'assign'],
  },
  {
    id: 'opti.assignment.problem',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Assignment Problem',
    description: 'Define and preview assignment problems: agents, tasks, cost matrix',
    navigationType: 'action',
    target: 'assignment.problem',
    keywords: ['assignment problem', 'agents', 'tasks', 'cost matrix', 'matching editor', 'workers'],
  },
  {
    id: 'opti.assignment.solvers',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Assignment Solvers',
    description: 'Choose which solvers to race on the assignment problem',
    navigationType: 'action',
    target: 'assignment.solvers',
    keywords: ['assignment solvers', 'matching solvers', 'workforce solvers', 'configure solvers', 'solver race'],
  },
  {
    id: 'opti.partitioning',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Partitioning',
    description: 'Graph partitioning, clustering, load balancing, data partitioning',
    navigationType: 'action',
    target: 'partitioning',
    keywords: ['partitioning', 'clustering', 'balancing', 'partition', 'divide', 'split'],
  },
  {
    id: 'opti.partitioning.problem',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Partitioning Problem',
    description: 'Define and preview partitioning problems: graph, parts, balance',
    navigationType: 'action',
    target: 'partitioning.problem',
    keywords: ['partitioning problem', 'graph', 'parts', 'balance', 'cluster editor', 'partition editor'],
  },
  {
    id: 'opti.partitioning.solvers',
    section: 'opti',
    surface: OPTI_SURFACE,
    label: 'Partitioning Solvers',
    description: 'Choose which solvers to race on the partitioning problem',
    navigationType: 'action',
    target: 'partitioning.solvers',
    keywords: ['partitioning solvers', 'clustering solvers', 'balancing solvers', 'configure solvers', 'solver race'],
  },

  // ── Admin ──────────────────────────────────────────────────────────────
  {
    id: 'admin.users',
    section: 'admin',
    label: 'User Management',
    description:
      'View and manage user accounts, roles, and permissions; the profile Billing tab shows payments, subscription standing and credit funding; the AI advisory filter lists accounts the AI advisory flagged, with bulk Contain',
    navigationType: 'tab',
    target: '0', // AdminTab.Users
    keywords: [
      'users',
      'accounts',
      'roles',
      'permissions',
      'manage users',
      'ai advisories',
      'flagged accounts',
      'billing',
      'payments',
    ],
    requiresAdmin: true,
  },
  {
    id: 'admin.credit_analytics',
    section: 'admin',
    label: 'Credit Analytics',
    description:
      'Credits per user and adjustments, margins against provider invoices, org and API usage, ElevenLabs plan usage, and the transaction ledger',
    navigationType: 'tab',
    target: '15', // AdminTab.CreditAnalytics
    keywords: ['credits', 'billing', 'usage', 'add credits', 'balance', 'cost', 'elevenlabs', 'vendor plan'],
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
    description:
      'Check configuration and connectivity: test email, database and OAuth providers, probe integrations, override circuit breakers',
    navigationType: 'tab',
    target: '29', // AdminTab.SystemHealth
    keywords: ['health', 'monitoring', 'status'],
    requiresAdmin: true,
  },
  {
    id: 'admin.llm_dashboard',
    section: 'admin',
    label: 'Models',
    description: 'Models users can pick: status, access, rank, prices and discovery',
    navigationType: 'tab',
    target: '24', // AdminTab.Models
    keywords: [
      'llm',
      'models',
      'model access',
      'model pricing',
      'prices',
      'rank',
      'ai',
      'dashboard',
      'enable model',
      'entitlements',
    ],
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
    description:
      'List, create and edit organizations: members, top up credits, adjust seats, sync from Stripe, grant a free org, convert a granted org to paid or revoke the grant',
    navigationType: 'tab',
    target: '14', // AdminTab.Organizations
    keywords: ['organizations', 'teams', 'tenants', 'companies', 'billing', 'payments'],
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
    label: 'Waitlist',
    description: 'Manage the waitlist and send invites to people waiting for access',
    navigationType: 'tab',
    target: '12', // AdminTab.Waitlist
    keywords: ['subscribers', 'waitlist', 'approvals', 'signups'],
    requiresAdmin: true,
  },
  {
    id: 'admin.revenue',
    section: 'admin',
    label: 'Revenue',
    description: 'MRR, ARR, paying customers, new and churned MRR, MRR by plan and at-risk subscriptions over time',
    navigationType: 'tab',
    target: '72', // AdminTab.Revenue
    keywords: ['revenue', 'mrr', 'arr', 'churn', 'recurring revenue', 'paying customers', 'at risk'],
    requiresAdmin: true,
  },
  {
    id: 'admin.subscriptions',
    section: 'admin',
    label: 'Subscriptions',
    description:
      'Look up customer subscriptions (past due, mismatched, canceling, comped, churned); cancel, resume, sync from Stripe, edit credits per cycle, extend or end comps',
    navigationType: 'tab',
    target: '13', // AdminTab.Subscriptions
    keywords: ['subscriptions', 'billing', 'past due', 'comped', 'sync from stripe'],
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
    description:
      'Manage the meta-prompt that generates agent system prompts: versions, activation, generation model and rate limit',
    navigationType: 'tab',
    target: '23', // AdminTab.AgentOps
    keywords: ['agents', 'agent ops', 'meta-prompt', 'agent prompt generation'],
    requiresAdmin: true,
  },
  {
    id: 'admin.security_dashboard',
    section: 'admin',
    label: 'Security Dashboard',
    description:
      'Security views: Incident (queues, alarms, payments), Firewall (traffic and blocked requests) and Scans (scheduled security scan results)',
    navigationType: 'tab',
    target: '26', // AdminTab.SecurityDashboard
    keywords: ['security', 'threats', 'firewall', 'waf', 'security scans'],
    requiresAdmin: true,
  },
  {
    id: 'admin.system_prompts',
    section: 'admin',
    label: 'System Prompts',
    description:
      'Edit system prompts as versioned overrides of the code defaults (history, revert), see usage, and manage Global Knowledge Files sent with every chat',
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
    label: "What's New",
    description: "Manage the What's New modals and the weekly highlights Slack post",
    navigationType: 'tab',
    target: '32', // AdminTab.WhatsNewModals
    keywords: ['whats new', 'updates', 'announcement modal', 'weekly highlights'],
    requiresAdmin: true,
  },
  {
    id: 'admin.rapid_reply',
    section: 'admin',
    label: 'Rapid Reply',
    description:
      'Configure Rapid Reply, a fast model that answers while the main model works: model mappings, fallback, thresholds, metrics and a test run',
    navigationType: 'tab',
    target: '25', // AdminTab.RapidReply
    keywords: ['rapid reply', 'quick responses', 'fast model', 'model mapping'],
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
    id: 'admin.feedback',
    section: 'admin',
    label: 'Feedback',
    description: 'View and manage user feedback, bug reports, and feature requests',
    navigationType: 'tab',
    target: '2', // AdminTab.Feedback
    keywords: ['feedback', 'bug reports', 'feature requests', 'user feedback', 'complaints'],
    requiresAdmin: true,
  },
  {
    id: 'admin.files',
    section: 'admin',
    label: 'Files',
    description: 'Manage app-level file uploads and their tags, including the Gated tag',
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
    description: 'Internal team contact directory',
    navigationType: 'tab',
    target: '28', // AdminTab.Team
    keywords: ['team', 'staff', 'contacts', 'directory'],
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
    id: 'admin.dashboard',
    section: 'admin',
    label: 'Dashboard',
    description:
      'Admin landing overview: signups, active users, client mix, links to the other dashboards, and the AI advisory strip (shown while flags await review) with flagged accounts, shared IPs and domains',
    navigationType: 'tab',
    target: '67', // AdminTab.Dashboard
    keywords: ['dashboard', 'overview', 'home', 'summary', 'signups', 'kpis', 'ai advisories', 'flagged accounts'],
    requiresAdmin: true,
  },
  {
    id: 'admin.help_analytics',
    section: 'admin',
    label: 'Help usage',
    description: 'What users ask the in-app help assistant, which help articles they read, and unanswered questions',
    navigationType: 'tab',
    target: '39', // AdminTab.HelpAnalytics
    keywords: ['help', 'help usage', 'help analytics', 'support questions', 'docs usage', 'unanswered'],
    requiresAdmin: true,
  },
  {
    id: 'admin.partner_signups',
    section: 'admin',
    label: 'Partner signups',
    description: 'Rules that auto-add verified signups from a partner email domain to an organization, with backfill',
    navigationType: 'tab',
    target: '55', // AdminTab.PartnerSignupRules
    keywords: ['partner', 'partner signups', 'email domain', 'auto-join', 'domain rules', 'organization signup'],
    requiresAdmin: true,
  },
  {
    id: 'admin.signup_domain_holds',
    section: 'admin',
    label: 'Signup domain holds',
    description:
      'Review email domains whose free signup credits are held as suspicious; confirm or release them, with the AI advisory verdict on each hold',
    navigationType: 'tab',
    target: '68', // AdminTab.SignupDomainHolds
    keywords: [
      'domain holds',
      'suspicious signups',
      'disposable email',
      'signup abuse',
      'held credits',
      'fraud',
      'ai advisory',
    ],
    requiresAdmin: true,
  },
  {
    id: 'admin.moderation_incidents',
    section: 'admin',
    label: 'Moderation review',
    description: 'Review image moderation incidents that are waiting for a verdict',
    navigationType: 'tab',
    target: '74', // AdminTab.ModerationIncidents
    keywords: ['moderation', 'image moderation', 'incident review', 'flagged images', 'false positive'],
    requiresAdmin: true,
  },
  {
    id: 'admin.text_moderation_review',
    section: 'admin',
    label: 'Text moderation review',
    description:
      'Review users throttled or pending suspension for flagged prompts, or with a severe-category hit; confirm the suspension, keep them throttled or return them to active',
    navigationType: 'tab',
    target: '84', // AdminTab.TextModerationReview
    keywords: [
      'text moderation',
      'flagged prompts',
      'moderation hits',
      'suspend pending',
      'throttled users',
      'moderation appeal',
    ],
    requiresAdmin: true,
  },
  {
    id: 'admin.signup_risk_review',
    section: 'admin',
    label: 'Risk review',
    description: 'Review new accounts whose signup risk score reached the review threshold; approve or suspend them',
    navigationType: 'tab',
    target: '69', // AdminTab.SignupRiskReview
    keywords: [
      'risk review',
      'risk score',
      'flagged signups',
      'suspicious accounts',
      'signup abuse',
      'approve account',
    ],
    requiresAdmin: true,
  },
  {
    id: 'admin.shadow_detections',
    section: 'admin',
    label: 'Detections',
    description:
      'Grade what abuse detectors would have done, without acting, to measure their precision; each detection shows its AI advisory assessment',
    navigationType: 'tab',
    target: '73', // AdminTab.ShadowDetections
    keywords: [
      'detections',
      'shadow detections',
      'detector precision',
      'false positives',
      'abuse detection',
      'ai advisory assessment',
    ],
    requiresAdmin: true,
  },
  {
    id: 'admin.stripe_disputes',
    section: 'admin',
    label: 'Disputes',
    description:
      'Resolve Stripe disputes on organization or unmatched payments and undo an automatic account containment',
    navigationType: 'tab',
    target: '75', // AdminTab.StripeDisputes
    keywords: ['disputes', 'chargebacks', 'stripe', 'lost dispute', 'contain'],
    requiresAdmin: true,
  },
  {
    id: 'admin.spend_monitor',
    section: 'admin',
    label: 'Spend monitor',
    description:
      'Watch live credit spend and open spend incidents, freeze or lift spending for a user, organization or API key, and see what the automatic pause would do',
    navigationType: 'tab',
    target: '83', // AdminTab.SpendMonitor
    keywords: ['spend', 'credits', 'spike', 'freeze', 'pause', 'incident'],
    requiresAdmin: true,
  },
  {
    id: 'admin.held_signup_grants',
    section: 'admin',
    label: 'Held signup grants',
    description: 'Release free signup credits held by the daily budget, in bulk, with revoke',
    navigationType: 'tab',
    target: '70', // AdminTab.HeldSignupGrants
    keywords: ['held grants', 'signup budget', 'free credits', 'release credits', 'bulk release'],
    requiresAdmin: true,
  },
  {
    id: 'admin.migrate_users',
    section: 'admin',
    label: 'Migration',
    description:
      'Bulk-migrate users into the platform and optionally send welcome emails (only when user migration is enabled)',
    navigationType: 'tab',
    target: '6', // AdminTab.Migrate
    keywords: ['migrate', 'migration', 'import users', 'move users', 'welcome email'],
    requiresAdmin: true,
  },
  {
    id: 'admin.growth_pricing',
    section: 'admin',
    label: 'Pricing',
    description:
      'Growth and monetization knobs: credit pricing, free-credit grants, referral credits and related pricing settings',
    navigationType: 'tab',
    target: '64', // AdminTab.GrowthPricing
    keywords: ['pricing', 'prices', 'credit price', 'free credits', 'referral credits', 'monetization', 'growth'],
    requiresAdmin: true,
  },
  {
    id: 'admin.preference_arena',
    section: 'admin',
    label: 'Preference arena',
    description:
      'Import answer pairs for the rate-two-answers arena, toggle them, and review vote quality and model win rates',
    navigationType: 'tab',
    target: '71', // AdminTab.PreferenceArena
    keywords: ['preference arena', 'arena', 'rate answers', 'pairwise votes', 'gold questions', 'model win rate'],
    requiresAdmin: true,
  },
  {
    id: 'admin.email_marketing',
    section: 'admin',
    label: 'Email marketing',
    description: 'Build marketing email templates and send email campaigns to users',
    navigationType: 'tab',
    target: '36', // AdminTab.EmailMarketing
    keywords: ['email marketing', 'campaigns', 'newsletter', 'email templates', 'marketing email'],
    requiresAdmin: true,
  },
  {
    id: 'admin.secops_triage',
    section: 'admin',
    label: 'Security scan issue filing',
    description:
      'Security page, Scans view: GitHub issue filing status, recent filing runs and its settings (dry run, repository, Slack)',
    navigationType: 'tab',
    target: '51', // AdminTab.SecOpsTriage, retired: opens the Security page's Scans view
    keywords: ['secops', 'security triage', 'security alerts', 'vulnerabilities', 'security issues'],
    requiresAdmin: true,
  },
  {
    id: 'admin.audit_log',
    section: 'admin',
    label: 'Audit log',
    description:
      'Review recorded admin and system changes with their actors and reasons; filter, export CSV, and sign off critical actions in the Needs review queue',
    navigationType: 'tab',
    target: '66', // AdminTab.AuditLog
    keywords: ['audit log', 'audit trail', 'who changed', 'change history', 'activity log', 'compliance'],
    requiresAdmin: true,
  },
  {
    id: 'admin.access_review',
    section: 'admin',
    label: 'Access review',
    description:
      'Quarterly review of who holds admin access: confirm or revoke each admin, flag dormant and no-MFA accounts, export the signed-off review as CSV',
    navigationType: 'tab',
    target: '81', // AdminTab.AccessReview
    keywords: ['access review', 'quarterly review', 'admin access', 'dormant admins', 'least privilege', 'compliance'],
    requiresAdmin: true,
  },
  {
    id: 'admin.spend_explorer',
    section: 'admin',
    label: 'Spend explorer',
    description:
      'AI provider cost per day or hour with spikes against the rolling median, split by provider, model, feature or account type, and the accounts that drove any day',
    navigationType: 'tab',
    target: '82', // AdminTab.SpendExplorer
    keywords: ['spend', 'ai cost', 'cost spike', 'provider cost', 'top spenders', 'cogs'],
    requiresAdmin: true,
  },
  {
    id: 'admin.approvals',
    section: 'admin',
    label: 'Approvals',
    description: 'Approve or reject sensitive admin actions another admin submitted for a second approval',
    navigationType: 'tab',
    target: '76', // AdminTab.Approvals
    keywords: ['approvals', 'approve', 'two-person', 'pending admin actions', 'second admin'],
    requiresAdmin: true,
  },
  {
    id: 'admin.tutorials',
    section: 'admin',
    label: 'Tutorials',
    description: 'Switch guided tutorials on or off, edit their words, and see the tutorials each package contributes',
    navigationType: 'tab',
    target: '77', // AdminTab.Tutorials
    keywords: ['tutorials', 'guided tutorials', 'walkthrough', 'onboarding', 'coach', 'tutorial modules'],
    requiresAdmin: true,
  },
  {
    id: 'admin.oauth_clients',
    section: 'admin',
    label: 'OAuth clients',
    description: 'Register OAuth client apps, edit their redirect URIs and rotate client secrets',
    navigationType: 'tab',
    target: '63', // AdminTab.OAuthClients
    keywords: ['oauth', 'oauth clients', 'client id', 'client secret', 'redirect uri', 'third-party apps'],
    requiresAdmin: true,
  },
  {
    id: 'admin.api_key_scopes',
    section: 'admin',
    label: 'API key scopes',
    description: 'Preflight which API keys would lose access before requiring a new scope on an endpoint',
    navigationType: 'tab',
    target: '61', // AdminTab.ApiKeyScopePreflight
    keywords: ['api key scopes', 'scopes', 'api keys', 'preflight', 'permissions', 'scope migration'],
    requiresAdmin: true,
  },
  {
    id: 'admin.legacy_api_keys',
    section: 'admin',
    label: 'Legacy API keys',
    description: 'See which recently used API keys still rely on legacy access, and their owners',
    navigationType: 'tab',
    target: '79', // AdminTab.LegacyApiKeys
    keywords: ['legacy api keys', 'legacy keys', 'api keys', 'grandfathered', 'scoped key', 'key owners'],
    requiresAdmin: true,
  },
  {
    id: 'admin.published_pages',
    section: 'admin',
    label: 'Published pages',
    description: 'Moderate publicly published pages: review reported ones, take a page down or restore it',
    navigationType: 'tab',
    target: '54', // AdminTab.PublishedPages
    keywords: ['published pages', 'public pages', 'moderation', 'takedown', 'reported content', 'abuse'],
    requiresAdmin: true,
  },
  {
    id: 'admin.gears',
    section: 'admin',
    label: 'Gears',
    description:
      'Override the Gears progression system live: toggle gears, change credit rewards, reword cards and CTAs',
    navigationType: 'tab',
    target: '56', // AdminTab.ManageGears
    keywords: ['gears', 'progression', 'rewards', 'gamification', 'achievements', 'onboarding rewards'],
    requiresAdmin: true,
  },
  {
    id: 'admin.model_lifecycle',
    section: 'admin',
    label: 'Model lifecycle',
    description: 'Models > Discovery: discovery runs, lifecycle suggestions and stale model references',
    navigationType: 'tab',
    // AdminTab.ModelLifecycle, whose slug aliases to the Models tab's Discovery section.
    target: '58',
    keywords: [
      'model lifecycle',
      'deprecation',
      'deprecated models',
      'model retirement',
      'successor model',
      'end of life',
    ],
    requiresAdmin: true,
  },
  {
    id: 'admin.retrieval',
    section: 'admin',
    label: 'Retrieval',
    description:
      'How often the model chooses to call knowledge-retrieval tools when they are offered rather than forced',
    navigationType: 'tab',
    target: '60', // AdminTab.RetrievalRate
    keywords: ['retrieval', 'retrieval rate', 'rag', 'knowledge tools', 'search usage'],
    requiresAdmin: true,
  },
  {
    id: 'admin.context_inspector',
    section: 'admin',
    label: 'Context inspector',
    description: 'Inspect per-request LLM context telemetry: prompt size, context health and anomalies',
    navigationType: 'tab',
    target: '40', // AdminTab.ContextInspector
    keywords: ['context', 'context window', 'prompt size', 'telemetry', 'tokens', 'context health'],
    requiresAdmin: true,
  },
  {
    id: 'admin.stuck_executions',
    section: 'admin',
    label: 'Stuck executions',
    description: 'Find agent executions that stopped progressing and release their concurrency slots',
    navigationType: 'tab',
    target: '53', // AdminTab.AgentExecutions
    keywords: ['stuck agents', 'agent executions', 'hung', 'stalled', 'concurrency slots', 'release'],
    requiresAdmin: true,
  },
  {
    id: 'admin.embed_keys',
    section: 'admin',
    label: 'Embed keys',
    description:
      'Create, configure and rotate embed keys and their allowed origins for embedding Bike4Mind on other sites',
    navigationType: 'tab',
    target: '57', // AdminTab.EmbedKeys
    keywords: ['embed', 'embed keys', 'widget', 'allowed origins', 'iframe', 'embedding'],
    requiresAdmin: true,
  },
  {
    id: 'admin.voice',
    section: 'admin',
    label: 'Voice',
    description: 'Configure voice assistant agents and the default voice for users without a personal selection',
    navigationType: 'tab',
    target: '52', // AdminTab.VoiceSettings
    keywords: ['voice', 'voice agent', 'speech', 'elevenlabs', 'voice assistant'],
    requiresAdmin: true,
  },
  {
    id: 'admin.sre_agent',
    section: 'admin',
    label: 'SRE agent',
    description:
      'Configure and monitor the SRE agent pipeline that triages production errors: controls, models and patterns',
    navigationType: 'tab',
    target: '44', // AdminTab.SreAgent
    keywords: ['sre', 'sre agent', 'error triage', 'auto-fix', 'production errors', 'incident'],
    requiresAdmin: true,
  },
  {
    id: 'admin.integrations',
    section: 'admin',
    label: 'Integrations',
    description: 'Health and uptime of third-party integrations (GitHub, Jira, Confluence, Slack and others)',
    navigationType: 'tab',
    target: '43', // AdminTab.IntegrationHealth
    keywords: ['integrations', 'integration health', 'connectors', 'uptime', 'third-party', 'outage'],
    requiresAdmin: true,
  },
  {
    id: 'admin.dead_letters',
    section: 'admin',
    label: 'Dead letters',
    description: 'Inspect dead-letter queues and replay failed background messages',
    navigationType: 'tab',
    target: '42', // AdminTab.DlqReplay
    keywords: ['dlq', 'dead letters', 'dead-letter queue', 'failed messages', 'replay', 'retry'],
    requiresAdmin: true,
  },
  {
    id: 'admin.ai_operations',
    section: 'admin',
    label: 'AI operations',
    description: 'Admin AI spend, agreement, budget caps, kill switches and autonomy readiness',
    navigationType: 'tab',
    target: '78',
    keywords: ['AI operations', 'AI spend', 'agreement', 'kill switch', 'autonomy', 'AI budget'],
    requiresAdmin: true,
  },
  {
    id: 'admin.roles',
    section: 'admin',
    label: 'Roles',
    description:
      'Create admin roles from templates, edit the permissions each role grants, and delete roles nobody holds',
    navigationType: 'tab',
    target: '80', // AdminTab.Roles
    keywords: ['roles', 'admin roles', 'permissions', 'role templates', 'delegated admin', 'access', 'support role'],
    requiresAdmin: true,
  },
  {
    id: 'admin.rate_limits',
    section: 'admin',
    label: 'Rate limits',
    description:
      'Monitor rate-limit usage and throttling against third-party integration APIs (GitHub, Jira, Confluence, Slack); per-plan API request limits are in Admin Settings',
    navigationType: 'tab',
    target: '41', // AdminTab.RateLimits
    keywords: ['rate limit', 'rate limits', 'throttle', 'throttling', 'quota', 'requests per minute', '429'],
    requiresAdmin: true,
  },
  {
    id: 'admin.github',
    section: 'admin',
    label: 'GitHub',
    description:
      'Configure the system GitHub connection (GitHub App or service-account token) and the repository allow-list',
    navigationType: 'tab',
    target: '38', // AdminTab.GitHubConnection
    keywords: ['github', 'github app', 'repositories', 'repo whitelist', 'personal access token', 'source control'],
    requiresAdmin: true,
  },
  {
    id: 'admin.webhook_logs',
    section: 'admin',
    label: 'Webhook logs',
    description: 'Browse incoming webhook deliveries with their status, payload and processing outcome',
    navigationType: 'tab',
    target: '37', // AdminTab.WebhookAuditLogs
    keywords: ['webhooks', 'webhook logs', 'deliveries', 'payload', 'webhook failures'],
    requiresAdmin: true,
  },
  {
    id: 'admin.integration_demand',
    section: 'admin',
    label: 'Integration demand',
    description: 'Which integrations users have requested from the Integrations page roadmap, and who asked',
    navigationType: 'tab',
    target: '65', // AdminTab.IntegrationDemand
    keywords: ['integration requests', 'roadmap', 'demand', 'requested integrations', 'feature requests'],
    requiresAdmin: true,
  },
  {
    id: 'admin.pr_digest',
    section: 'admin',
    label: 'PR digest',
    description: 'Configure and generate the pull-request digest report, then review and send it',
    navigationType: 'tab',
    target: '59', // AdminTab.PrReport
    keywords: ['pr digest', 'pull requests', 'pr report', 'changelog digest', 'weekly digest'],
    requiresAdmin: true,
  },
  {
    id: 'admin.release_notes',
    section: 'admin',
    label: 'Release notes',
    description: 'Write, edit and publish product release notes',
    navigationType: 'tab',
    target: '62', // AdminTab.ReleaseNotes
    keywords: ['release notes', 'changelog', 'what changed', 'product updates', 'releases'],
    requiresAdmin: true,
  },
  {
    id: 'admin.api_reference',
    section: 'admin',
    label: 'API reference',
    description: 'Browse the public REST API reference: endpoints, parameters and schemas',
    navigationType: 'tab',
    target: '45', // AdminTab.ApiReference
    keywords: ['api', 'api reference', 'endpoints', 'openapi', 'rest api', 'api docs'],
    requiresAdmin: true,
  },
  {
    id: 'admin.api_cookbook',
    section: 'admin',
    label: 'API cookbook',
    description: 'Practical recipes and code patterns for working with the API',
    navigationType: 'tab',
    target: '49', // AdminTab.ApiCookbook
    keywords: ['api cookbook', 'recipes', 'examples', 'code samples', 'api guide'],
    requiresAdmin: true,
  },
  {
    id: 'admin.architecture',
    section: 'admin',
    label: 'Architecture',
    description: 'System architecture diagrams of the platform and its data flows',
    navigationType: 'tab',
    target: '47', // AdminTab.ArchitectureDiagrams
    keywords: ['architecture', 'diagrams', 'system design', 'data flow', 'infrastructure'],
    requiresAdmin: true,
  },
  {
    id: 'admin.dependencies',
    section: 'admin',
    label: 'Dependencies',
    description: "Overview of the platform's software and service dependencies",
    navigationType: 'tab',
    target: '48', // AdminTab.Dependencies
    keywords: ['dependencies', 'packages', 'libraries', 'third-party services', 'versions'],
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

// --- Contributed views ---
//
// An extension package adds admin pages here instead of editing VIEW_REGISTRY. Registration is a side
// effect of importing the generated contribution module (@bike4mind/server-utils:
// premiumNavigableViews.generated.ts, via navigation/registerContributedViews.ts), so a process that
// skips that import sees only the static registry. A contributed view is an admin-only route under a
// reserved path, and the limits below bound what the set can add to the admin prompt.

export const CONTRIBUTED_ADMIN_VIEW_PATH_PREFIX = '/admin/ext/';
export const CONTRIBUTED_VIEW_ID_PREFIX = 'admin.ext.';
export const MAX_CONTRIBUTED_VIEWS = 8;
export const MAX_CONTRIBUTED_VIEW_ID_LENGTH = 60;
export const MAX_CONTRIBUTED_VIEW_LABEL_LENGTH = 60;
export const MAX_CONTRIBUTED_VIEW_DESCRIPTION_LENGTH = 160;
export const MAX_CONTRIBUTED_VIEW_KEYWORDS = 6;
export const MAX_CONTRIBUTED_VIEW_KEYWORD_LENGTH = 30;

const contributedViews = new Map<string, NavigableView>();

const CONTRIBUTED_VIEW_ID_PATTERN = /^admin\.ext\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
// `%` and `\` are rejected with `..` so an encoded or backslash dot segment cannot leave the prefix.
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const UNSAFE_TARGET_PATTERN = /[$?#%\\\s\u0000-\u001f\u007f-\u009f]|\.\./;
// Control characters (tab, NUL, NEL, ...) and bidi overrides have no place in one-line prompt text.
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const LINE_BREAK_PATTERN = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/;

export interface ContributedViewsRegistration {
  registered: string[];
  /** Ids an earlier contribution already registered; the first one is kept. */
  duplicates: string[];
  /**
   * Entries that are not objects, break a field rule (id, section, navigation type, admin flag, target,
   * label, description or keywords), reuse a static view id, or arrive past the cap.
   */
  rejected: string[];
}

function isBoundedLine(value: unknown, max: number, mustBeTrimmed: boolean): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= max &&
    !LINE_BREAK_PATTERN.test(value) &&
    (!mustBeTrimmed || value === value.trim())
  );
}

function isValidContributedView(view: unknown): view is NavigableView {
  if (typeof view !== 'object' || view === null || Array.isArray(view)) return false;
  const { id, section, navigationType, requiresAdmin, target, label, description, keywords } = view as Record<
    string,
    unknown
  >;
  return (
    typeof id === 'string' &&
    id.length <= MAX_CONTRIBUTED_VIEW_ID_LENGTH &&
    CONTRIBUTED_VIEW_ID_PATTERN.test(id) &&
    !VIEW_REGISTRY.some(v => v.id === id) &&
    section === 'admin' &&
    navigationType === 'route' &&
    requiresAdmin === true &&
    typeof target === 'string' &&
    target.startsWith(CONTRIBUTED_ADMIN_VIEW_PATH_PREFIX) &&
    target.length > CONTRIBUTED_ADMIN_VIEW_PATH_PREFIX.length &&
    !UNSAFE_TARGET_PATTERN.test(target) &&
    isBoundedLine(label, MAX_CONTRIBUTED_VIEW_LABEL_LENGTH, true) &&
    isBoundedLine(description, MAX_CONTRIBUTED_VIEW_DESCRIPTION_LENGTH, false) &&
    Array.isArray(keywords) &&
    keywords.length <= MAX_CONTRIBUTED_VIEW_KEYWORDS &&
    keywords.every(keyword => isBoundedLine(keyword, MAX_CONTRIBUTED_VIEW_KEYWORD_LENGTH, false))
  );
}

/** Adds contributed views. Never replaces an existing view. */
export function registerContributedViews(views: readonly NavigableView[]): ContributedViewsRegistration {
  const result: ContributedViewsRegistration = { registered: [], duplicates: [], rejected: [] };
  for (const view of views) {
    if (!isValidContributedView(view)) {
      const id = (view as { id?: unknown } | null | undefined)?.id;
      result.rejected.push(typeof id === 'string' ? id : '(no id)');
      continue;
    }
    const existing = contributedViews.get(view.id);
    if (existing) {
      // The same module can be evaluated by more than one entrypoint; that is not a clash.
      if (existing !== view) result.duplicates.push(view.id);
    } else if (contributedViews.size >= MAX_CONTRIBUTED_VIEWS) {
      result.rejected.push(view.id);
    } else {
      contributedViews.set(view.id, view);
      result.registered.push(view.id);
    }
  }
  return result;
}

/** @internal Tests only: drops every contributed view. */
export function resetContributedViews(): void {
  contributedViews.clear();
}

// Helpers

/** Look up a view by its ID, static views first. */
export function getViewById(viewId: string): NavigableView | undefined {
  return VIEW_REGISTRY.find(v => v.id === viewId) ?? contributedViews.get(viewId);
}

/**
 * Filter views by section and admin status.
 */
export function getFilteredViews(options?: { section?: ViewSection; isAdmin?: boolean }): NavigableView[] {
  const views = contributedViews.size === 0 ? VIEW_REGISTRY : [...VIEW_REGISTRY, ...contributedViews.values()];
  return views.filter(v => {
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
    'Example - if the user asks "how do I configure the routing solvers":',
    '1. Call navigate_view with suggestions: [{viewId: "opti.routing.solvers", reason: "Configure routing solvers here"}]',
    '2. AND write your text answer',
    '',
    sections,
  ].join('\n');
}

// Whole-word match, so a short keyword like "ai" is not hidden by "email" or "domain".
const containsWholeWords = (text: string, phrase: string): boolean => {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i').test(text);
};

// Keywords already spelled out in the label or description add tokens without adding meaning.
const extraKeywordsOf = (view: NavigableView): string[] => {
  const shown = `${view.label} ${view.description}`;
  return view.keywords.filter(keyword => !containsWholeWords(shown, keyword));
};

const adminViewLine = (view: NavigableView): string => {
  const extra = extraKeywordsOf(view);
  const keywords = extra.length > 0 ? ` (also: ${extra.join(', ')})` : '';
  return `- ${view.id}: ${view.label} \u2014 ${view.description}${keywords}`;
};

/**
 * The admin-only views, as an appendix to the non-admin `getViewSummaryForLLM()` text. Kept
 * separate so the base summary is byte-identical for every user and can sit in the
 * deployment-wide cached prompt prefix; this appendix rides in the per-caller tail instead.
 */
export function getAdminViewSummaryForLLM(): string {
  const lines = [...VIEW_REGISTRY.filter(v => v.requiresAdmin), ...contributedViews.values()].map(adminViewLine);
  return [
    '# Admin views for navigate_view',
    '',
    'This user is an admin, so these views are also available:',
    '',
    ...lines,
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
