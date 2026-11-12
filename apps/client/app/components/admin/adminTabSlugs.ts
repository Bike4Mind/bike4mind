import {
  ADMIN_AUDIT_LOG_TAB_SLUG,
  ADMIN_DLQ_REPLAY_TAB_SLUG,
  ADMIN_FEEDBACK_TAB_SLUG,
  ADMIN_MODERATION_INCIDENTS_TAB_SLUG,
  ADMIN_USERS_TAB_SLUG,
} from '@bike4mind/common';
import { AdminTab } from './adminSidebarConfig';
import {
  ADMIN_ANALYTICS_TAB_SLUG,
  ADMIN_EVENTS_TAB_SLUG,
  ADMIN_INTEGRATION_DEMAND_TAB_SLUG,
  ADMIN_MODEL_LOGS_TAB_SLUG,
  ADMIN_MODEL_METRICS_TAB_SLUG,
  ADMIN_ORGANIZATIONS_TAB_SLUG,
  ADMIN_SECURITY_DASHBOARD_TAB_SLUG,
  ADMIN_SETTINGS_TAB_SLUG,
  ADMIN_SHADOW_DETECTIONS_TAB_SLUG,
  ADMIN_STRIPE_DISPUTES_TAB_SLUG,
  ADMIN_SIGNUP_DOMAIN_HOLDS_TAB_SLUG,
  ADMIN_SIGNUP_RISK_REVIEW_TAB_SLUG,
  ADMIN_SUBSCRIPTIONS_TAB_SLUG,
  ADMIN_WAITLIST_TAB_SLUG,
  ADMIN_WEBHOOK_AUDIT_LOGS_TAB_SLUG,
} from './adminTabParams';
import { MODELS_SECTION_PARAM, MODELS_TAB_SLUG } from './Models/modelsSearch';

/**
 * AdminTab -> URL slug, for the console's `?tab=` param.
 *
 * `AdminTab`'s values are positional, so they must never reach a URL, and the slugs are written
 * out by hand rather than derived from the enum key names: links live in Slack messages and
 * emails, and renaming an enum member must not break them. `Record<AdminTab, string>` makes a
 * new tab without a slug a compile error. Never drop a slug; a renamed slug stays as an alias.
 */
const ADMIN_TAB_TO_SLUG: Readonly<Record<AdminTab, string>> = {
  [AdminTab.Dashboard]: 'dashboard',
  [AdminTab.Users]: ADMIN_USERS_TAB_SLUG,
  [AdminTab.AdminSettings]: ADMIN_SETTINGS_TAB_SLUG,
  [AdminTab.Feedback]: ADMIN_FEEDBACK_TAB_SLUG,
  [AdminTab.Analytics]: ADMIN_ANALYTICS_TAB_SLUG,
  [AdminTab.RegistrationInvites]: 'registration-invites',
  [AdminTab.Migrate]: 'migrate',
  [AdminTab.Modals]: 'modals',
  [AdminTab.Files]: 'files',
  [AdminTab.Documentation]: 'documentation',
  [AdminTab.WorldTime]: 'world-time',
  [AdminTab.Waitlist]: ADMIN_WAITLIST_TAB_SLUG,
  [AdminTab.Subscriptions]: ADMIN_SUBSCRIPTIONS_TAB_SLUG,
  [AdminTab.Revenue]: 'revenue',
  [AdminTab.Organizations]: ADMIN_ORGANIZATIONS_TAB_SLUG,
  [AdminTab.CreditAnalytics]: 'credit-analytics',
  [AdminTab.SecretsRotation]: 'secrets-rotation',
  [AdminTab.ModelLogs]: ADMIN_MODEL_LOGS_TAB_SLUG,
  [AdminTab.ModelMetrics]: ADMIN_MODEL_METRICS_TAB_SLUG,
  [AdminTab.EventMetrics]: ADMIN_EVENTS_TAB_SLUG,
  [AdminTab.SystemPrompts]: 'system-prompts',
  [AdminTab.IdentityProviders]: 'identity-providers',
  [AdminTab.AgentOps]: 'agent-ops',
  [AdminTab.Models]: MODELS_TAB_SLUG,
  [AdminTab.RapidReply]: 'rapid-reply',
  [AdminTab.SecurityDashboard]: ADMIN_SECURITY_DASHBOARD_TAB_SLUG,
  [AdminTab.EmailVerification]: 'email-verification',
  [AdminTab.Team]: 'team',
  [AdminTab.SystemHealth]: 'system-health',
  [AdminTab.SlackWorkspaces]: 'slack-workspaces',
  [AdminTab.ToolDefinitions]: 'tool-definitions',
  [AdminTab.WhatsNewModals]: 'whats-new-modals',
  [AdminTab.SlackMetrics]: 'slack-metrics',
  [AdminTab.SystemSecrets]: 'system-secrets',
  [AdminTab.LiveOpsTriage]: 'live-ops-triage',
  [AdminTab.EmailMarketing]: 'email-marketing',
  [AdminTab.WebhookAuditLogs]: ADMIN_WEBHOOK_AUDIT_LOGS_TAB_SLUG,
  [AdminTab.GitHubConnection]: 'github-connection',
  [AdminTab.HelpAnalytics]: 'help-analytics',
  [AdminTab.ContextInspector]: 'context-inspector',
  [AdminTab.RateLimits]: 'rate-limits',
  [AdminTab.DlqReplay]: ADMIN_DLQ_REPLAY_TAB_SLUG,
  [AdminTab.IntegrationHealth]: 'integration-health',
  [AdminTab.SreAgent]: 'sre-agent',
  [AdminTab.ManageGears]: 'manage-gears',
  [AdminTab.ApiReference]: 'api-reference',
  [AdminTab.ArchitectureDiagrams]: 'architecture-diagrams',
  [AdminTab.Dependencies]: 'dependencies',
  [AdminTab.ApiCookbook]: 'api-cookbook',
  [AdminTab.SecOpsTriage]: 'sec-ops-triage',
  [AdminTab.VoiceSettings]: 'voice-settings',
  [AdminTab.AgentExecutions]: 'agent-executions',
  [AdminTab.PublishedPages]: 'published-pages',
  [AdminTab.PartnerSignupRules]: 'partner-signup-rules',
  [AdminTab.SignupDomainHolds]: ADMIN_SIGNUP_DOMAIN_HOLDS_TAB_SLUG,
  [AdminTab.SignupRiskReview]: ADMIN_SIGNUP_RISK_REVIEW_TAB_SLUG,
  [AdminTab.ShadowDetections]: ADMIN_SHADOW_DETECTIONS_TAB_SLUG,
  [AdminTab.ModerationIncidents]: ADMIN_MODERATION_INCIDENTS_TAB_SLUG,
  [AdminTab.StripeDisputes]: ADMIN_STRIPE_DISPUTES_TAB_SLUG,
  [AdminTab.HeldSignupGrants]: 'held-signup-grants',
  [AdminTab.EmbedKeys]: 'embed-keys',
  [AdminTab.ModelLifecycle]: 'model-lifecycle',
  [AdminTab.PrReport]: 'pr-report',
  [AdminTab.RetrievalRate]: 'retrieval-rate',
  [AdminTab.ApiKeyScopePreflight]: 'api-key-scope-preflight',
  [AdminTab.ReleaseNotes]: 'release-notes',
  [AdminTab.OAuthClients]: 'oauth-clients',
  [AdminTab.GrowthPricing]: 'growth-pricing',
  [AdminTab.PreferenceArena]: 'preference-arena',
  [AdminTab.IntegrationDemand]: ADMIN_INTEGRATION_DEMAND_TAB_SLUG,
  [AdminTab.AuditLog]: ADMIN_AUDIT_LOG_TAB_SLUG,
  [AdminTab.Approvals]: 'approvals',
  [AdminTab.Tutorials]: 'tutorials',
  [AdminTab.AiOperations]: 'ai-operations',
};

/**
 * A Map, not an object literal: the key comes straight from the query string, and an object
 * lookup would resolve `?tab=toString` to an inherited Object.prototype member instead of
 * undefined - which then passes the caller's `!== undefined` guard.
 */
type AdminTabAlias = { tab: AdminTab; search?: Readonly<Record<string, string>> };

/**
 * Slugs that shared links still carry but that no longer name their own page; useAdminTabUrlSync rewrites the URL
 * to the current slug plus the alias's search params. Model lifecycle became the Models tab's Discovery section, so
 * AdminTab.ModelLifecycle stays a member only to keep its slug (and the palette entry that targets it) working.
 */
const ADMIN_TAB_ALIASES: ReadonlyMap<string, AdminTabAlias> = new Map([
  ['subscribers', { tab: AdminTab.Waitlist }],
  ['llm-dashboard', { tab: AdminTab.Models }],
  [
    ADMIN_TAB_TO_SLUG[AdminTab.ModelLifecycle],
    { tab: AdminTab.Models, search: { [MODELS_SECTION_PARAM]: 'discovery' } },
  ],
]);

const SLUG_TO_ADMIN_TAB: ReadonlyMap<string, AdminTab> = new Map([
  ...Object.entries(ADMIN_TAB_TO_SLUG).map(([tab, slug]): [string, AdminTab] => [slug, Number(tab) as AdminTab]),
  ...[...ADMIN_TAB_ALIASES].map(([slug, alias]): [string, AdminTab] => [slug, alias.tab]),
]);

/** Resolves a `?tab=` slug, or undefined when it is absent or not a known tab. */
export function adminTabFromSlug(slug: string | undefined): AdminTab | undefined {
  if (!slug) return undefined;
  return SLUG_TO_ADMIN_TAB.get(slug);
}

/** The alias a legacy `?tab=` slug resolves through, or undefined for a current slug. */
export function adminTabAlias(slug: string | undefined): AdminTabAlias | undefined {
  if (!slug) return undefined;
  return ADMIN_TAB_ALIASES.get(slug);
}

/**
 * The slug for a tab, or undefined for anything that is not an AdminTab member (a stale string
 * id, null). Callers must treat undefined as "leave the URL alone".
 */
export function adminTabToSlug(tab: AdminTab | string | null): string | undefined {
  if (typeof tab !== 'number') return undefined;
  return ADMIN_TAB_TO_SLUG[tab];
}
