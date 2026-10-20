import { ADMIN_AUDIT_LOG_TAB_SLUG, ADMIN_FEEDBACK_TAB_SLUG, ADMIN_USERS_TAB_SLUG } from '@bike4mind/common';
import { AdminTab } from './adminSidebarConfig';

/**
 * AdminTab -> URL slug, for the console's `?tab=` param.
 *
 * `AdminTab`'s values are positional, so they must never reach a URL, and the slugs are written
 * out by hand rather than derived from the enum key names: links live in Slack messages and
 * emails, and renaming an enum member must not break them. `Record<AdminTab, string>` makes a
 * new tab without a slug a compile error. Never change an existing slug.
 */
const ADMIN_TAB_TO_SLUG: Readonly<Record<AdminTab, string>> = {
  [AdminTab.Users]: ADMIN_USERS_TAB_SLUG,
  [AdminTab.AdminSettings]: 'admin-settings',
  [AdminTab.Feedback]: ADMIN_FEEDBACK_TAB_SLUG,
  [AdminTab.Analytics]: 'analytics',
  [AdminTab.Accounts]: 'accounts',
  [AdminTab.RegistrationInvites]: 'registration-invites',
  [AdminTab.Migrate]: 'migrate',
  [AdminTab.Modals]: 'modals',
  [AdminTab.Files]: 'files',
  [AdminTab.Documentation]: 'documentation',
  [AdminTab.WorldTime]: 'world-time',
  [AdminTab.Analysts]: 'analysts',
  [AdminTab.Subscribers]: 'subscribers',
  [AdminTab.Subscriptions]: 'subscriptions',
  [AdminTab.Organizations]: 'organizations',
  [AdminTab.CreditAnalytics]: 'credit-analytics',
  [AdminTab.SecretsRotation]: 'secrets-rotation',
  [AdminTab.BulkImport]: 'bulk-import',
  [AdminTab.ModelLogs]: 'model-logs',
  [AdminTab.ModelMetrics]: 'model-metrics',
  [AdminTab.EventMetrics]: 'event-metrics',
  [AdminTab.SystemPrompts]: 'system-prompts',
  [AdminTab.IdentityProviders]: 'identity-providers',
  [AdminTab.AgentOps]: 'agent-ops',
  [AdminTab.LLMDashboard]: 'llm-dashboard',
  [AdminTab.RapidReply]: 'rapid-reply',
  [AdminTab.SecurityDashboard]: 'security-dashboard',
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
  [AdminTab.WebhookAuditLogs]: 'webhook-audit-logs',
  [AdminTab.GitHubConnection]: 'github-connection',
  [AdminTab.HelpAnalytics]: 'help-analytics',
  [AdminTab.ContextInspector]: 'context-inspector',
  [AdminTab.RateLimits]: 'rate-limits',
  [AdminTab.DlqReplay]: 'dlq-replay',
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
  [AdminTab.EmbedKeys]: 'embed-keys',
  [AdminTab.ModelLifecycle]: 'model-lifecycle',
  [AdminTab.PrReport]: 'pr-report',
  [AdminTab.RetrievalRate]: 'retrieval-rate',
  [AdminTab.ApiKeyScopePreflight]: 'api-key-scope-preflight',
  [AdminTab.ReleaseNotes]: 'release-notes',
  [AdminTab.OAuthClients]: 'oauth-clients',
  [AdminTab.GrowthPricing]: 'growth-pricing',
  [AdminTab.IntegrationDemand]: 'integration-demand',
  [AdminTab.AuditLog]: ADMIN_AUDIT_LOG_TAB_SLUG,
};

/**
 * A Map, not an object literal: the key comes straight from the query string, and an object
 * lookup would resolve `?tab=toString` to an inherited Object.prototype member instead of
 * undefined - which then passes the caller's `!== undefined` guard.
 */
const SLUG_TO_ADMIN_TAB: ReadonlyMap<string, AdminTab> = new Map(
  Object.entries(ADMIN_TAB_TO_SLUG).map(([tab, slug]) => [slug, Number(tab) as AdminTab])
);

/** Resolves a `?tab=` slug, or undefined when it is absent or not a known tab. */
export function adminTabFromSlug(slug: string | undefined): AdminTab | undefined {
  if (!slug) return undefined;
  return SLUG_TO_ADMIN_TAB.get(slug);
}

/**
 * The slug for a tab, or undefined for anything that is not an AdminTab member (a stale string
 * id, null). Callers must treat undefined as "leave the URL alone".
 */
export function adminTabToSlug(tab: AdminTab | string | null): string | undefined {
  if (typeof tab !== 'number') return undefined;
  return ADMIN_TAB_TO_SLUG[tab];
}
