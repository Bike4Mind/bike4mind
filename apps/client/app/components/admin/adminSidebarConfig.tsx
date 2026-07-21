import type { ElementType } from 'react';
import ContactSupportIcon from '@mui/icons-material/ContactSupport';
import FlagIcon from '@mui/icons-material/Flag';
import HandymanIcon from '@mui/icons-material/Handyman';
import LanguageIcon from '@mui/icons-material/Language';
import NewspaperIcon from '@mui/icons-material/Newspaper';
import PeopleIcon from '@mui/icons-material/People';
import GroupsIcon from '@mui/icons-material/Groups';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import QueryStatsIcon from '@mui/icons-material/QueryStats';
import WidgetsIcon from '@mui/icons-material/Widgets';
import BuildIcon from '@mui/icons-material/Build';
import BusinessIcon from '@mui/icons-material/Business';
import CreditCardIcon from '@mui/icons-material/CreditCard';
import SecurityIcon from '@mui/icons-material/Security';
import DescriptionIcon from '@mui/icons-material/Description';
import SettingsSuggestIcon from '@mui/icons-material/SettingsSuggest';
import AccountBoxIcon from '@mui/icons-material/AccountBox';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CleaningServicesIcon from '@mui/icons-material/CleaningServices';
import PsychologyIcon from '@mui/icons-material/Psychology';
import SpeedIcon from '@mui/icons-material/Speed';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import EmailIcon from '@mui/icons-material/Email';
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart';
import ForumIcon from '@mui/icons-material/Forum';
import HelpCenterIcon from '@mui/icons-material/HelpCenter';
import BugReportIcon from '@mui/icons-material/BugReport';
import QueueIcon from '@mui/icons-material/Queue';
import WebhookIcon from '@mui/icons-material/Webhook';
import IntegrationInstructionsIcon from '@mui/icons-material/IntegrationInstructions';
import ApiIcon from '@mui/icons-material/Api';
import SchemaIcon from '@mui/icons-material/Schema';
import InventoryIcon from '@mui/icons-material/Inventory';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import HandshakeIcon from '@mui/icons-material/Handshake';

export enum AdminTab {
  Users = 0,
  AdminSettings = 1,
  Feedbacks = 2,
  Analytics = 3,
  Accounts = 4,
  RegistrationInvites = 5,
  Migrate = 6,
  Modals = 7,
  Files = 8,
  Documentation = 9,
  WorldTime = 10,
  Analysts = 11,
  Subscribers = 12,
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
}

/**
 * Conditional-visibility gate keys. An item with a `gate` only renders when the
 * matching boolean (derived from SidebarNav props) is true.
 */
export type SidebarGate = 'userMigration' | 'liveOpsTriage';

/** Special-cased end decorators (e.g. the waiting-subscribers badge). */
export type SidebarBadge = 'waitingSubscribers';

export type SidebarItem = {
  Icon: ElementType;
  tab: AdminTab;
  label: string;
  testid?: string;
  gate?: SidebarGate;
  badge?: SidebarBadge;
};

export type SidebarSection = {
  /** Stable key - drives expand state and the localStorage persistence key. */
  key: string;
  Icon: ElementType;
  label: string;
  items: SidebarItem[];
};

/**
 * Single source of truth for the admin sidebar. Each `AdminTab` that has a
 * sidebar entry appears exactly once here - adding a tab is a one-line change.
 * Order within a section and the `testid` values are preserved from the
 * original hand-written JSX so existing E2E selectors keep working.
 */
export const SIDEBAR_SECTIONS: SidebarSection[] = [
  {
    key: 'userOps',
    Icon: PeopleIcon,
    label: 'User Ops',
    items: [
      { Icon: PeopleIcon, tab: AdminTab.Users, label: 'Users', testid: 'admin-users-tab-btn' },
      { Icon: EmailIcon, tab: AdminTab.EmailVerification, label: 'Email Verification' },
      { Icon: ContactSupportIcon, tab: AdminTab.Feedbacks, label: 'Feedbacks' },
      { Icon: PersonAddIcon, tab: AdminTab.Migrate, label: 'Migration', gate: 'userMigration' },
      { Icon: QueryStatsIcon, tab: AdminTab.Analytics, label: 'Analytics' },
      {
        Icon: PersonAddIcon,
        tab: AdminTab.RegistrationInvites,
        label: 'Invite Center',
        testid: 'admin-invite-center-tab-btn',
      },
      { Icon: PeopleIcon, tab: AdminTab.Subscribers, label: 'Subscribers', badge: 'waitingSubscribers' },
      { Icon: HandshakeIcon, tab: AdminTab.PartnerSignupRules, label: 'Partner Signup Rules' },
      { Icon: EmailIcon, tab: AdminTab.EmailMarketing, label: 'Email Marketing' },
      { Icon: PeopleIcon, tab: AdminTab.Subscriptions, label: 'Subscriptions' },
      { Icon: BusinessIcon, tab: AdminTab.Organizations, label: 'Organizations' },
      { Icon: CreditCardIcon, tab: AdminTab.CreditAnalytics, label: 'Credit Analytics' },
      { Icon: GroupsIcon, tab: AdminTab.Team, label: 'Team' },
    ],
  },
  {
    key: 'security',
    Icon: SecurityIcon,
    label: 'Security',
    items: [
      { Icon: SecurityIcon, tab: AdminTab.SecOpsTriage, label: 'SecOps Triage', testid: 'admin-secops-triage-btn' },
      {
        Icon: SecurityIcon,
        tab: AdminTab.SecurityDashboard,
        label: 'Security Dashboard',
        testid: 'admin-security-dashboard-btn',
      },
      {
        Icon: FlagIcon,
        tab: AdminTab.PublishedPages,
        label: 'Published Pages',
        testid: 'admin-published-pages-btn',
      },
      { Icon: SecurityIcon, tab: AdminTab.SecretsRotation, label: 'Secrets Rotation' },
      { Icon: SecurityIcon, tab: AdminTab.SystemSecrets, label: 'System Secrets' },
      { Icon: AccountBoxIcon, tab: AdminTab.IdentityProviders, label: 'Identity Providers' },
    ],
  },
  {
    key: 'reliability',
    Icon: MonitorHeartIcon,
    label: 'Reliability / Incident Ops',
    items: [
      { Icon: BugReportIcon, tab: AdminTab.LiveOpsTriage, label: 'LiveOps Triage', gate: 'liveOpsTriage' },
      { Icon: BugReportIcon, tab: AdminTab.SreAgent, label: 'SRE Agent', testid: 'admin-sre-agent-btn' },
      { Icon: QueueIcon, tab: AdminTab.DlqReplay, label: 'DLQ Management', testid: 'admin-dlq-replay-btn' },
      { Icon: SpeedIcon, tab: AdminTab.RateLimits, label: 'Rate Limits', testid: 'admin-rate-limits-btn' },
      { Icon: MonitorHeartIcon, tab: AdminTab.SystemHealth, label: 'System Health' },
      { Icon: QueryStatsIcon, tab: AdminTab.EventMetrics, label: 'Event Metrics' },
    ],
  },
  {
    key: 'aiAgents',
    Icon: PsychologyIcon,
    label: 'AI & Agents',
    items: [
      { Icon: AutoAwesomeIcon, tab: AdminTab.AgentOps, label: 'Agent Operations' },
      { Icon: CleaningServicesIcon, tab: AdminTab.AgentExecutions, label: 'Stuck Agent Executions' },
      { Icon: BuildIcon, tab: AdminTab.ToolDefinitions, label: 'Tool Definitions' },
      { Icon: ApiIcon, tab: AdminTab.EmbedKeys, label: 'Embed Keys', testid: 'admin-embed-keys-btn' },
      { Icon: DescriptionIcon, tab: AdminTab.SystemPrompts, label: 'System Prompts' },
      { Icon: SettingsSuggestIcon, tab: AdminTab.ManageGears, label: 'Manage Gears' },
      { Icon: SpeedIcon, tab: AdminTab.RapidReply, label: 'Rapid Reply' },
      { Icon: GraphicEqIcon, tab: AdminTab.VoiceSettings, label: 'Voice Settings' },
      { Icon: PsychologyIcon, tab: AdminTab.LLMDashboard, label: 'LLM Dashboard' },
      { Icon: QueryStatsIcon, tab: AdminTab.ModelMetrics, label: 'Model Metrics' },
      {
        Icon: MonitorHeartIcon,
        tab: AdminTab.ContextInspector,
        label: 'Context Inspector',
        testid: 'admin-context-inspector-btn',
      },
    ],
  },
  {
    key: 'integrations',
    Icon: IntegrationInstructionsIcon,
    label: 'Integrations',
    items: [
      { Icon: ForumIcon, tab: AdminTab.SlackWorkspaces, label: 'Slack Workspaces' },
      {
        Icon: BuildIcon,
        tab: AdminTab.GitHubConnection,
        label: 'GitHub Connection',
        testid: 'admin-github-connection-btn',
      },
      {
        Icon: IntegrationInstructionsIcon,
        tab: AdminTab.IntegrationHealth,
        label: 'Integration Health',
        testid: 'admin-integration-health-btn',
      },
      { Icon: WebhookIcon, tab: AdminTab.WebhookAuditLogs, label: 'Webhook Logs' },
      { Icon: QueryStatsIcon, tab: AdminTab.SlackMetrics, label: 'Slack Metrics' },
    ],
  },
  {
    key: 'docs',
    Icon: MenuBookIcon,
    label: 'Docs & Architecture',
    items: [
      { Icon: NewspaperIcon, tab: AdminTab.Documentation, label: 'Documentation' },
      { Icon: ApiIcon, tab: AdminTab.ApiReference, label: 'API Reference' },
      { Icon: MenuBookIcon, tab: AdminTab.ApiCookbook, label: 'API Cookbook' },
      { Icon: SchemaIcon, tab: AdminTab.ArchitectureDiagrams, label: 'Architecture Diagrams' },
      { Icon: InventoryIcon, tab: AdminTab.Dependencies, label: 'Dependencies' },
      {
        Icon: HelpCenterIcon,
        tab: AdminTab.HelpAnalytics,
        label: 'Help Analytics',
        testid: 'admin-help-analytics-btn',
      },
    ],
  },
  {
    key: 'generalOps',
    Icon: HandymanIcon,
    label: 'General Ops',
    items: [
      { Icon: HandymanIcon, tab: AdminTab.AdminSettings, label: 'Admin Settings' },
      { Icon: WidgetsIcon, tab: AdminTab.Modals, label: 'Modals' },
      { Icon: NewspaperIcon, tab: AdminTab.WhatsNewModals, label: "What's New" },
      { Icon: LanguageIcon, tab: AdminTab.WorldTime, label: 'World Time' },
    ],
  },
];

export const SIDEBAR_EXPANDED_STORAGE_KEY = 'admin-sidebar-expanded-sections';

/** Find which section owns a given tab (used to expand the active section on mount). */
export const findSectionKeyForTab = (tab: AdminTab | string | null): string | undefined =>
  SIDEBAR_SECTIONS.find(section => section.items.some(item => item.tab === tab))?.key;
