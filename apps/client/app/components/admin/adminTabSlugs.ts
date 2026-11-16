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
  ADMIN_REVENUE_TAB_SLUG,
  ADMIN_SECURITY_DASHBOARD_TAB_SLUG,
  ADMIN_SETTINGS_TAB_SLUG,
  ADMIN_SHADOW_DETECTIONS_TAB_SLUG,
  ADMIN_STRIPE_DISPUTES_TAB_SLUG,
  ADMIN_SIGNUP_DOMAIN_HOLDS_TAB_SLUG,
  ADMIN_SIGNUP_RISK_REVIEW_TAB_SLUG,
  ADMIN_SUBSCRIPTIONS_TAB_SLUG,
  ADMIN_WAITLIST_TAB_SLUG,
  ADMIN_WEBHOOK_AUDIT_LOGS_TAB_SLUG,
  type AdminSearch,
} from './adminTabParams';

type RetiredTab = AdminTab.RegistrationInvites | AdminTab.PartnerSignupRules;

/**
 * AdminTab -> URL slug, for the console's `?tab=` param.
 *
 * `AdminTab`'s values are positional, so they must never reach a URL, and the slugs are written
 * out by hand rather than derived from the enum key names: links live in Slack messages and
 * emails, and renaming an enum member must not break them. The `Record` type makes a new tab
 * without a slug a compile error. Never change an existing slug.
 */
const ADMIN_TAB_TO_SLUG: Readonly<Record<Exclude<AdminTab, RetiredTab>, string>> = {
  [AdminTab.Dashboard]: 'dashboard',
  [AdminTab.Users]: ADMIN_USERS_TAB_SLUG,
  [AdminTab.AdminSettings]: ADMIN_SETTINGS_TAB_SLUG,
  [AdminTab.Feedback]: ADMIN_FEEDBACK_TAB_SLUG,
  [AdminTab.Analytics]: ADMIN_ANALYTICS_TAB_SLUG,
  [AdminTab.Migrate]: 'migrate',
  [AdminTab.Modals]: 'modals',
  [AdminTab.Files]: 'files',
  [AdminTab.Documentation]: 'documentation',
  [AdminTab.WorldTime]: 'world-time',
  [AdminTab.Waitlist]: ADMIN_WAITLIST_TAB_SLUG,
  [AdminTab.Subscriptions]: ADMIN_SUBSCRIPTIONS_TAB_SLUG,
  [AdminTab.Revenue]: ADMIN_REVENUE_TAB_SLUG,
  [AdminTab.Organizations]: ADMIN_ORGANIZATIONS_TAB_SLUG,
  [AdminTab.CreditAnalytics]: 'credit-analytics',
  [AdminTab.SecretsRotation]: 'secrets-rotation',
  [AdminTab.ModelLogs]: ADMIN_MODEL_LOGS_TAB_SLUG,
  [AdminTab.ModelMetrics]: ADMIN_MODEL_METRICS_TAB_SLUG,
  [AdminTab.EventMetrics]: ADMIN_EVENTS_TAB_SLUG,
  [AdminTab.SystemPrompts]: 'system-prompts',
  [AdminTab.IdentityProviders]: 'identity-providers',
  [AdminTab.AgentOps]: 'agent-ops',
  [AdminTab.LLMDashboard]: 'llm-dashboard',
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
  [AdminTab.LegacyApiKeys]: 'legacy-api-keys',
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

// Retired tabs now live in Invite Center sections; their old slugs stay as redirects, and in-app links resolve here.
const RETIRED_TAB_SLUGS: Readonly<Record<RetiredTab, string>> = {
  [AdminTab.RegistrationInvites]: 'registration-invites',
  [AdminTab.PartnerSignupRules]: 'partner-signup-rules',
};

export type AdminTabRedirect = { tab: AdminTab; search?: Partial<AdminSearch> };

/**
 * Old slugs that shared links still carry; useAdminTabUrlSync rewrites the URL to the target tab
 * plus `search`. A Map for the same prototype-safety reason as SLUG_TO_ADMIN_TAB.
 */
export const ADMIN_TAB_SLUG_REDIRECTS: ReadonlyMap<string, AdminTabRedirect> = new Map([
  ['subscribers', { tab: AdminTab.Waitlist }],
  [RETIRED_TAB_SLUGS[AdminTab.RegistrationInvites], { tab: AdminTab.Waitlist, search: { inviteSection: 'invites' } }],
  [RETIRED_TAB_SLUGS[AdminTab.PartnerSignupRules], { tab: AdminTab.Waitlist, search: { inviteSection: 'packages' } }],
]);

/**
 * A Map, not an object literal: the key comes straight from the query string, and an object
 * lookup would resolve `?tab=toString` to an inherited Object.prototype member instead of
 * undefined - which then passes the caller's `!== undefined` guard.
 */
const SLUG_TO_ADMIN_TAB: ReadonlyMap<string, AdminTab> = new Map(
  Object.entries(ADMIN_TAB_TO_SLUG).map(([tab, slug]): [string, AdminTab] => [slug, Number(tab) as AdminTab])
);

/** Resolves a `?tab=` slug, or undefined when it is absent, a redirect, or not a known tab. */
export function adminTabFromSlug(slug: string | undefined): AdminTab | undefined {
  if (!slug) return undefined;
  return SLUG_TO_ADMIN_TAB.get(slug);
}

/** The redirect an old `?tab=` slug carries, or undefined for a current or unknown slug. */
export function adminTabRedirectFromSlug(slug: string | undefined): AdminTabRedirect | undefined {
  if (!slug) return undefined;
  return ADMIN_TAB_SLUG_REDIRECTS.get(slug);
}

/**
 * The slug for a tab, or undefined for anything that has no slug of its own (a stale string id,
 * null, a retired tab). Callers must treat undefined as "leave the URL alone".
 */
export function adminTabToSlug(tab: AdminTab | string | null): string | undefined {
  if (typeof tab !== 'number') return undefined;
  return (ADMIN_TAB_TO_SLUG as Partial<Record<AdminTab, string>>)[tab];
}

/**
 * The `/admin` search that opens a tab, sending a retired tab to the Invite Center section that
 * replaced it. `tab` is undefined for a value with no tab to name.
 */
export function adminTabLinkSearch(tab: AdminTab): Partial<AdminSearch> & { tab: string | undefined } {
  const redirect = adminTabRedirectFromSlug((RETIRED_TAB_SLUGS as Partial<Record<AdminTab, string>>)[tab]);
  return redirect ? { ...redirect.search, tab: adminTabToSlug(redirect.tab) } : { tab: adminTabToSlug(tab) };
}
