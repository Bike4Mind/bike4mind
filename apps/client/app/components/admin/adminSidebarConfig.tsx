import type { ElementType } from 'react';
import {
  Activity,
  AppWindow,
  ArrowRightLeft,
  AudioLines,
  Bot,
  Brain,
  BookMarked,
  BookOpen,
  Building2,
  CalendarX,
  ChartColumn,
  ChartLine,
  ChartSpline,
  Clock,
  Code,
  Coins,
  CreditCard,
  Database,
  FileText,
  Fingerprint,
  Gauge,
  GitBranch,
  GitPullRequest,
  Globe,
  HandCoins,
  Handshake,
  Hash,
  HeartPulse,
  Inbox,
  Key,
  KeyRound,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  Lock,
  MailCheck,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  Network,
  Newspaper,
  NotebookText,
  Package,
  Plug,
  Radar,
  RotateCcw,
  ScanSearch,
  ScrollText,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Sparkles,
  SquareTerminal,
  Tag,
  Timer,
  TrendingUp,
  UserPlus,
  UserSearch,
  Users,
  UsersRound,
  Webhook,
  Workflow,
  Wrench,
  Zap,
} from 'lucide-react';

export enum AdminTab {
  Users = 0,
  AdminSettings = 1,
  Feedback = 2,
  Analytics = 3,
  Accounts = 4,
  RegistrationInvites = 5,
  Migrate = 6,
  Modals = 7,
  Files = 8,
  Documentation = 9,
  WorldTime = 10,
  Analysts = 11,
  Waitlist = 12,
  Subscriptions = 13,
  Organizations = 14,
  CreditAnalytics = 15,
  SecretsRotation = 16,
  BulkImport = 17,
  ModelLogs = 18,
  ModelMetrics = 19,
  EventMetrics = 20,
  SystemPrompts = 21,
  IdentityProviders = 22,
  AgentOps = 23,
  LLMDashboard = 24,
  RapidReply = 25,
  SecurityDashboard = 26,
  EmailVerification = 27,
  Team = 28,
  SystemHealth = 29,
  SlackWorkspaces = 30,
  ToolDefinitions = 31,
  WhatsNewModals = 32,
  SlackMetrics = 33,
  SystemSecrets = 34,
  LiveOpsTriage = 35,
  EmailMarketing = 36,
  WebhookAuditLogs = 37,
  GitHubConnection = 38,
  HelpAnalytics = 39,
  ContextInspector = 40,
  RateLimits = 41,
  DlqReplay = 42,
  IntegrationHealth = 43,
  SreAgent = 44,
  ManageGears = 56,
  ApiReference = 45,
  ArchitectureDiagrams = 47,
  Dependencies = 48,
  ApiCookbook = 49,
  SecOpsTriage = 51,
  VoiceSettings = 52,
  AgentExecutions = 53,
  PublishedPages = 54,
  PartnerSignupRules = 55,
  EmbedKeys = 57,
  ModelLifecycle = 58,
  PrReport = 59,
  RetrievalRate = 60,
  ApiKeyScopePreflight = 61,
  ReleaseNotes = 62,
  OAuthClients = 63,
  GrowthPricing = 64,
  IntegrationDemand = 65,
  AuditLog = 66,
  Dashboard = 67,
  SignupDomainHolds = 68,
  SignupRiskReview = 69,
  HeldSignupGrants = 70,
  Revenue = 71,
}

/**
 * Conditional-visibility gate keys. An item with a `gate` only renders when the
 * matching boolean (derived from SidebarNav props) is true.
 */
export type SidebarGate = 'userMigration' | 'liveOpsTriage';

/** Special-cased end decorators (e.g. the waiting-subscribers badge). */
export type SidebarBadge = 'waitingSubscribers' | 'newSubscriptions';

export type SidebarItem = {
  /** A lucide stroke icon; the sidebar renders it at 16 px with a 2 px stroke. */
  Icon: ElementType;
  tab: AdminTab;
  /** One line in a 248 px sidebar: keep it short ("Credits", not "Credit Analytics"). */
  label: string;
  testid?: string;
  gate?: SidebarGate;
  badge?: SidebarBadge;
};

export type SidebarSection = {
  /** Stable key - persisted (the "More" state) and used in rail testids. */
  key: string;
  /** Used only on the collapsed icon rail, where it stands in for the whole section. */
  Icon: ElementType;
  label: string;
  /** Most used first: a long section shows only its first SIDEBAR_MORE_VISIBLE items until "More". */
  items: SidebarItem[];
};

/**
 * Single source of truth for the admin sidebar. Each `AdminTab` that has a sidebar entry appears
 * exactly once here - adding a tab is a one-line change. Sections and naming follow the "Sidebar"
 * rules in DESIGN_GUIDE.md. The `testid` values are what the E2E page objects select on.
 */
export const SIDEBAR_SECTIONS: SidebarSection[] = [
  {
    key: 'overview',
    Icon: LayoutDashboard,
    label: 'Overview',
    items: [
      { Icon: LayoutDashboard, tab: AdminTab.Dashboard, label: 'Dashboard', testid: 'admin-dashboard-tab-btn' },
      { Icon: ChartLine, tab: AdminTab.Analytics, label: 'Analytics' },
      { Icon: HeartPulse, tab: AdminTab.SystemHealth, label: 'System health' },
      { Icon: Activity, tab: AdminTab.EventMetrics, label: 'Events' },
      { Icon: LifeBuoy, tab: AdminTab.HelpAnalytics, label: 'Help usage', testid: 'admin-help-analytics-btn' },
    ],
  },
  {
    key: 'people',
    Icon: Users,
    label: 'People',
    items: [
      { Icon: Users, tab: AdminTab.Users, label: 'Users', testid: 'admin-users-tab-btn' },
      { Icon: Building2, tab: AdminTab.Organizations, label: 'Organizations', testid: 'admin-organizations-tab-btn' },
      { Icon: Inbox, tab: AdminTab.Waitlist, label: 'Waitlist', badge: 'waitingSubscribers' },
      { Icon: Megaphone, tab: AdminTab.EmailMarketing, label: 'Email marketing' },
      { Icon: UsersRound, tab: AdminTab.Team, label: 'Team' },
      { Icon: UserPlus, tab: AdminTab.RegistrationInvites, label: 'Invites', testid: 'admin-invite-center-tab-btn' },
      { Icon: MessageSquare, tab: AdminTab.Feedback, label: 'Feedback' },
      { Icon: MailCheck, tab: AdminTab.EmailVerification, label: 'Email verification' },
      { Icon: Handshake, tab: AdminTab.PartnerSignupRules, label: 'Partner signups' },
      { Icon: Handshake, tab: AdminTab.SignupDomainHolds, label: 'Signup domain holds' },
      {
        Icon: UserSearch,
        tab: AdminTab.SignupRiskReview,
        label: 'Risk review',
        testid: 'admin-signup-risk-review-btn',
      },
      { Icon: HandCoins, tab: AdminTab.HeldSignupGrants, label: 'Held signup grants' },
      { Icon: ArrowRightLeft, tab: AdminTab.Migrate, label: 'Migration', gate: 'userMigration' },
    ],
  },
  {
    key: 'money',
    Icon: Coins,
    label: 'Money',
    items: [
      { Icon: ChartSpline, tab: AdminTab.Revenue, label: 'Revenue', testid: 'admin-revenue-btn' },
      { Icon: Coins, tab: AdminTab.CreditAnalytics, label: 'Credits' },
      { Icon: CreditCard, tab: AdminTab.Subscriptions, label: 'Subscriptions', badge: 'newSubscriptions' },
      { Icon: Tag, tab: AdminTab.GrowthPricing, label: 'Pricing', testid: 'admin-growth-pricing-btn' },
    ],
  },
  {
    key: 'trust',
    Icon: ShieldCheck,
    label: 'Trust and safety',
    items: [
      { Icon: ShieldCheck, tab: AdminTab.SecurityDashboard, label: 'Security', testid: 'admin-security-dashboard-btn' },
      { Icon: ShieldAlert, tab: AdminTab.SecOpsTriage, label: 'SecOps triage', testid: 'admin-secops-triage-btn' },
      { Icon: ScrollText, tab: AdminTab.AuditLog, label: 'Audit log', testid: 'admin-audit-log-btn' },
      { Icon: Fingerprint, tab: AdminTab.IdentityProviders, label: 'Identity providers' },
      { Icon: KeyRound, tab: AdminTab.OAuthClients, label: 'OAuth clients', testid: 'admin-oauth-clients-btn' },
      { Icon: Key, tab: AdminTab.ApiKeyScopePreflight, label: 'API key scopes', testid: 'admin-scope-preflight-btn' },
      { Icon: Lock, tab: AdminTab.SystemSecrets, label: 'Secrets' },
      { Icon: RotateCcw, tab: AdminTab.SecretsRotation, label: 'Secret rotation' },
      { Icon: Globe, tab: AdminTab.PublishedPages, label: 'Published pages', testid: 'admin-published-pages-btn' },
    ],
  },
  {
    key: 'ai',
    Icon: Sparkles,
    label: 'AI',
    items: [
      { Icon: Brain, tab: AdminTab.LLMDashboard, label: 'Models' },
      { Icon: Bot, tab: AdminTab.AgentOps, label: 'Agents' },
      { Icon: FileText, tab: AdminTab.SystemPrompts, label: 'System prompts' },
      { Icon: Wrench, tab: AdminTab.ToolDefinitions, label: 'Tools' },
      { Icon: Settings, tab: AdminTab.ManageGears, label: 'Gears' },
      { Icon: ChartColumn, tab: AdminTab.ModelMetrics, label: 'Model metrics' },
      { Icon: CalendarX, tab: AdminTab.ModelLifecycle, label: 'Model lifecycle', testid: 'admin-model-lifecycle-btn' },
      { Icon: ScanSearch, tab: AdminTab.RetrievalRate, label: 'Retrieval', testid: 'admin-retrieval-rate-btn' },
      {
        Icon: Layers,
        tab: AdminTab.ContextInspector,
        label: 'Context inspector',
        testid: 'admin-context-inspector-btn',
      },
      { Icon: Timer, tab: AdminTab.AgentExecutions, label: 'Stuck executions' },
      { Icon: Code, tab: AdminTab.EmbedKeys, label: 'Embed keys', testid: 'admin-embed-keys-btn' },
      { Icon: Zap, tab: AdminTab.RapidReply, label: 'Rapid reply' },
      { Icon: AudioLines, tab: AdminTab.VoiceSettings, label: 'Voice' },
    ],
  },
  {
    key: 'platform',
    Icon: Workflow,
    label: 'Platform',
    items: [
      { Icon: Siren, tab: AdminTab.LiveOpsTriage, label: 'LiveOps triage', gate: 'liveOpsTriage' },
      { Icon: Radar, tab: AdminTab.SreAgent, label: 'SRE agent', testid: 'admin-sre-agent-btn' },
      { Icon: Plug, tab: AdminTab.IntegrationHealth, label: 'Integrations', testid: 'admin-integration-health-btn' },
      { Icon: Database, tab: AdminTab.DlqReplay, label: 'Dead letters', testid: 'admin-dlq-replay-btn' },
      { Icon: Gauge, tab: AdminTab.RateLimits, label: 'Rate limits', testid: 'admin-rate-limits-btn' },
      { Icon: Hash, tab: AdminTab.SlackWorkspaces, label: 'Slack workspaces' },
      { Icon: GitBranch, tab: AdminTab.GitHubConnection, label: 'GitHub', testid: 'admin-github-connection-btn' },
      { Icon: Webhook, tab: AdminTab.WebhookAuditLogs, label: 'Webhook logs' },
      { Icon: MessagesSquare, tab: AdminTab.SlackMetrics, label: 'Slack metrics' },
      {
        Icon: TrendingUp,
        tab: AdminTab.IntegrationDemand,
        label: 'Integration demand',
        testid: 'admin-integration-demand-btn',
      },
      { Icon: GitPullRequest, tab: AdminTab.PrReport, label: 'PR digest', testid: 'admin-pr-report-btn' },
    ],
  },
  {
    key: 'settings',
    Icon: Settings,
    label: 'Settings',
    items: [
      { Icon: Settings, tab: AdminTab.AdminSettings, label: 'General', testid: 'admin-settings-btn' },
      { Icon: AppWindow, tab: AdminTab.Modals, label: 'Modals' },
      { Icon: Newspaper, tab: AdminTab.WhatsNewModals, label: "What's new" },
      { Icon: NotebookText, tab: AdminTab.ReleaseNotes, label: 'Release notes', testid: 'admin-release-notes-btn' },
      { Icon: BookOpen, tab: AdminTab.Documentation, label: 'Docs' },
      { Icon: SquareTerminal, tab: AdminTab.ApiReference, label: 'API reference' },
      { Icon: BookMarked, tab: AdminTab.ApiCookbook, label: 'API cookbook' },
      { Icon: Network, tab: AdminTab.ArchitectureDiagrams, label: 'Architecture' },
      { Icon: Package, tab: AdminTab.Dependencies, label: 'Dependencies' },
      { Icon: Clock, tab: AdminTab.WorldTime, label: 'World time' },
    ],
  },
];

/** Find which section owns a given tab. */
export const findSectionKeyForTab = (tab: AdminTab | string | null): string | undefined =>
  SIDEBAR_SECTIONS.find(section => section.items.some(item => item.tab === tab))?.key;

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'admin-sidebar-collapsed';
/** Which long sections the admin has expanded past their "More" row. */
export const SIDEBAR_MORE_STORAGE_KEY = 'admin-sidebar-more-sections';

/** A section longer than this collapses behind a "More" row... */
export const SIDEBAR_MORE_THRESHOLD = 7;
/** ...showing this many items above it. */
export const SIDEBAR_MORE_VISIBLE = 5;

/**
 * The items a section shows and how many sit behind its "More" row. The active item is never
 * hidden: when it falls past the cut it is shown under the visible ones.
 */
export const splitSectionItems = (
  items: SidebarItem[],
  activeTab: AdminTab | string | null,
  expanded: boolean
): { shown: SidebarItem[]; hiddenCount: number } => {
  if (expanded || items.length <= SIDEBAR_MORE_THRESHOLD) return { shown: items, hiddenCount: 0 };
  const head = items.slice(0, SIDEBAR_MORE_VISIBLE);
  const activeInTail = items.slice(SIDEBAR_MORE_VISIBLE).find(item => item.tab === activeTab);
  const shown = activeInTail ? [...head, activeInTail] : head;
  return { shown, hiddenCount: items.length - shown.length };
};

/**
 * The sections an admin can see: gated items dropped, then (when `query` is non-blank) only the
 * items whose label or section label contains it. Sections left empty are omitted.
 */
export const filterSidebarSections = (
  sections: SidebarSection[],
  gates: Record<SidebarGate, boolean>,
  query: string
): SidebarSection[] => {
  const needle = query.trim().toLowerCase();
  return sections
    .map(section => {
      const sectionMatches = needle !== '' && section.label.toLowerCase().includes(needle);
      const items = section.items.filter(
        item =>
          (!item.gate || gates[item.gate]) &&
          (needle === '' || sectionMatches || item.label.toLowerCase().includes(needle))
      );
      return { ...section, items };
    })
    .filter(section => section.items.length > 0);
};
