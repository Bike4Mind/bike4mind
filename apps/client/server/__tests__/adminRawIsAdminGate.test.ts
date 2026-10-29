// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { blankStringLiterals } from './scopeCoverageHelpers';

/**
 * Admin routes gate through `adminApi()` with a per-method permission so a delegated admin
 * (`adminPermissions`) is honoured. A route that gates on the raw `isAdmin` flag
 * (`req.user.isAdmin`, `ensureAdmin(`) locks delegates out and bypasses the permission model.
 *
 * Invariant: no `pages/api/admin` route gates on the raw flag unless it calls `adminApi(` or is in
 * RAW_GATE_ALLOWLIST. The allowlist only shrinks: migrate a route, then delete its entry.
 * Entries for routes that no longer exist or no longer gate raw are tolerated.
 */

const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'admin');

const RAW_GATE_ALLOWLIST = new Set<string>([
  'abuse/bulk-execute.ts',
  'abuse/bulk-preview.ts',
  'activity-summary.ts',
  'agent-executions/cleanup.ts',
  'agent-executions/stuck.ts',
  'agent-ops-settings.ts',
  'agent-ops-settings/repair.ts',
  'agent-ops-settings/seed.ts',
  'agent-ops-settings/versions/[version]/activate.ts',
  'agent-ops-settings/versions/index.ts',
  'analytics.ts',
  'api-keys/scope-preflight.ts',
  'audit-log/[id].ts',
  'audit-log/alert-status.ts',
  'audit-log/export.ts',
  'audit-log/index.ts',
  'audit-log/summary.ts',
  'bulk-create-users.ts',
  'context-telemetry.ts',
  'context-telemetry/[id].ts',
  'context-telemetry/[id]/analyze.ts',
  'context-telemetry/[id]/create-issue.ts',
  'context-telemetry/dry-run-results.ts',
  'context-telemetry/export.ts',
  'context-telemetry/integration-status.ts',
  'context-telemetry/metrics.ts',
  'context-telemetry/test-config.ts',
  'create-user.ts',
  'credit-adjustments.ts',
  'dlq/history.ts',
  'dlq/messages.ts',
  'dlq/queues.ts',
  'dlq/replay.ts',
  'embedding-limits.ts',
  'emergency-login.ts',
  'event-metrics.ts',
  'gears/[key].ts',
  'gears/index.ts',
  'generate-highlights.ts',
  'github/connection.ts',
  'github/rate-limit.ts',
  'github/repositories.ts',
  'github/rotate-key.ts',
  'github/test.ts',
  'help-analytics.ts',
  'identity-providers/[id].ts',
  'identity-providers/index.ts',
  'integration-audit-logs/index.ts',
  'integration-health-dashboard.ts',
  'integrations/demand/[integrationId]/requesters.ts',
  'integrations/demand/index.ts',
  'liveops-triage-configs/[id].ts',
  'liveops-triage-configs/[id]/health.ts',
  'liveops-triage-configs/[id]/trigger.ts',
  'liveops-triage-configs/index.ts',
  'liveops-triage-configs/runs.ts',
  'liveops-triage-env.ts',
  'llm-models/configurations.ts',
  'mementos/reembed-ledger.ts',
  'mementos/reembed.ts',
  'model-deprecation-status.ts',
  'model-discovery.ts',
  'model-logs.ts',
  'model-logs/[id].ts',
  'model-metrics.ts',
  'model-prices.ts',
  'moderation-incidents/[id]/verdict.ts',
  'moderation-incidents/index.ts',
  'oauth-clients/[id]/index.ts',
  'oauth-clients/[id]/rotate-secret.ts',
  'oauth-clients/index.ts',
  'operations-model.ts',
  'organizations/[id]/convert-to-paid.ts',
  'organizations/[id]/group-types.ts',
  'organizations/[id]/reconcile-seats.ts',
  'organizations/[id]/revoke.ts',
  'organizations/[id]/seats.ts',
  'organizations/[id]/top-up.ts',
  'organizations/grant.ts',
  'organizations/grants.ts',
  'overwatch/backfill-first-seen.ts',
  'partner-signup-rules/[id].ts',
  'partner-signup-rules/backfill.ts',
  'partner-signup-rules/index.ts',
  'platform-usage.ts',
  'platform-usage/endpoints.ts',
  'pr-report/generate.ts',
  'pr-report/send.ts',
  'provider-invoices.ts',
  'published-artifacts/[id]/reports.ts',
  'published-artifacts/[id]/takedown.ts',
  'published-artifacts/index.ts',
  'qa/facets.ts',
  'qa/overview.ts',
  'qa/runs/[id].ts',
  'qa/runs/index.ts',
  'qa/tests.ts',
  'rate-limits.ts',
  'recalculate-message-counts.ts',
  'release-notes/[id].ts',
  'release-notes/[id]/status.ts',
  'release-notes/config.ts',
  'release-notes/index.ts',
  'retrieval-rate.ts',
  'saved-views/[id].ts',
  'saved-views/index.ts',
  'scoped-settings/effective.ts',
  'scoped-settings/index.ts',
  'security-scan-schedule/[scanType].ts',
  'security-scan-schedules/index.ts',
  'session-usage.ts',
  'sessions/[id]/index.ts',
  'sessions/[id]/quests.ts',
  'signup-anomaly.ts',
  'signup-domain-holds.ts',
  'signup-timeseries.ts',
  'slack-app/create.ts',
  'slack-app/manifest-status.ts',
  'slack-app/reconnect.ts',
  'slack-app/update-manifest.ts',
  'slack-audit-logs/index.ts',
  'spend-reconciliation.ts',
  'spend.ts',
  'subscriptions/export.ts',
  'subscriptions/index.ts',
  'subscriptions/summary.ts',
  'system-health.ts',
  'system-health/integration-health.ts',
  'system-health/test-database.ts',
  'system-health/test-email.ts',
  'system-health/test-oauth.ts',
  'system-secrets/[id].ts',
  'system-secrets/index.ts',
  'system-secrets/tier1-status.ts',
  'team-members.ts',
  'tool-definitions/[toolId].ts',
  'tool-definitions/index.ts',
  'tools/execute.ts',
  'upload-logo.ts',
  'usage-by-source.ts',
  'usage-margin.ts',
  'user-api-keys/[id]/rate-limit.ts',
  'user-api-keys/[id]/reset-rate-limit.ts',
  'user-api-keys/[id]/restore.ts',
  'user-api-keys/[id]/revoke.ts',
  'user-api-keys/[id]/rotate.ts',
  'users/[userId]/activity.ts',
  'users/[userId]/api-key-trust.ts',
  'users/[userId]/compliance.ts',
  'users/[userId]/credit-history.ts',
  'users/[userId]/credit-ledger-export.ts',
  'users/[userId]/credit-ledger.ts',
  'users/[userId]/credit-summary.ts',
  'users/[userId]/credit-transactions.ts',
  'users/[userId]/entitlements.ts',
  'users/[userId]/generate-api-key.ts',
  'users/[userId]/grant-subscription.ts',
  'users/[userId]/resend-email-change.ts',
  'users/[userId]/resend-verification.ts',
  'users/[userId]/revoke-api-keys.ts',
  'users/[userId]/sessions.ts',
  'users/[userId]/sign-ins.ts',
  'users/[userId]/signup-cluster.ts',
  'users/[userId]/subscriptions.ts',
  'users/[userId]/subscriptions/[subscriptionId]/credits.ts',
  'users/[userId]/subscriptions/[subscriptionId]/remove.ts',
  'users/[userId]/support-access.ts',
  'users/[userId]/timeline.ts',
  'users/[userId]/unlock-signup-grant.ts',
  'users/[userId]/unverify-email.ts',
  'users/[userId]/user-api-keys.ts',
  'users/[userId]/verify-email.ts',
  'users/bulk/execute.ts',
  'users/bulk/preview.ts',
  'users/bulk/undo.ts',
  'users/email-verification.ts',
  'users/export.ts',
  'users/index.ts',
  'users/summary.ts',
  'voice-agents/[id].ts',
  'voice-agents/index.ts',
  'webhook-logs/[deliveryId].ts',
  'webhook-logs/index.ts',
  'webhook-logs/stats.ts',
  'whats-new-highlights-config.ts',
  'whats-new-highlights-preview.ts',
]);

// Helpers that gate on the raw flag internally, so a route calling them is raw-gated even
// though its own source never names isAdmin.
const RAW_GATE_HELPER = /\b(?:authorizeSupportRead|canAdministerReleaseNotes)\s*\(/;
const RAW_GATE = /\b(?:req\.user|user)\s*[?!]*\s*\.\s*isAdmin\b|\bensureAdmin\s*\(/;
const ADMIN_API_CALL = /\badminApi\s*\(/;

/** Strings and comments are blanked first, so a quoted mention or a zod `isAdmin:` field is not a gate. */
export function usesRawIsAdminGate(source: string): boolean {
  const { code, terminated } = blankStringLiterals(source);
  if (!terminated) throw new Error('source ends inside a string, template or block comment');
  return (RAW_GATE.test(code) || RAW_GATE_HELPER.test(code)) && !ADMIN_API_CALL.test(code);
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const rel = (f: string) => path.relative(ROUTES_DIR, f).split(path.sep).join('/');
const files = routeFiles(ROUTES_DIR);

describe('usesRawIsAdminGate', () => {
  it.each([
    ['req.user?.isAdmin', 'if (!req.user?.isAdmin) throw new Error();'],
    ['req.user.isAdmin', 'if (!req.user.isAdmin) throw new Error();'],
    ['non-null req.user!.isAdmin', 'if (!req.user!.isAdmin) throw new Error();'],
    ['a local user binding', 'if (!user?.isAdmin) throw new Error();'],
    ['ensureAdmin(', 'ensureAdmin(req.user?.isAdmin);'],
  ])('flags %s', (_label, code) => {
    expect(usesRawIsAdminGate(`const handler = baseApi().get(async (req) => { ${code} });`)).toBe(true);
  });

  it.each([
    ['authorizeSupportRead(', 'const ctx = await authorizeSupportRead(req);'],
    ['canAdministerReleaseNotes(', 'if (!canAdministerReleaseNotes(req)) throw new Error();'],
  ])('flags a route gated through the raw-flag helper %s', (_label, code) => {
    expect(usesRawIsAdminGate(`const handler = baseApi().get(async (req) => { ${code} });`)).toBe(true);
  });

  it('does not flag a route that is gated by adminApi', () => {
    expect(usesRawIsAdminGate("adminApi({ adminPermissions: { GET: 'settings:manage' } }).get(async () => {})")).toBe(
      false
    );
  });

  it('ignores mentions in comments and strings', () => {
    const code = [
      '// check req.user.isAdmin below',
      "const msg = 'ensureAdmin( failed';",
      'const x = `req.user.isAdmin`;',
    ];
    expect(usesRawIsAdminGate(code.join('\n'))).toBe(false);
  });

  it('ignores a body field named isAdmin', () => {
    const code = 'const Schema = z.object({ isAdmin: z.boolean() }); if (validated.isAdmin) grant();';
    expect(usesRawIsAdminGate(code)).toBe(false);
  });
});

describe('admin routes do not gate on the raw isAdmin flag', () => {
  it('finds the admin route files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files.map(f => [rel(f), f]))('%s', (name, file) => {
    if (RAW_GATE_ALLOWLIST.has(name)) return;
    expect(
      usesRawIsAdminGate(readFileSync(file, 'utf8')),
      `${name} gates on raw isAdmin; use adminApi() with a per-method adminPermissions entry`
    ).toBe(false);
  });
});
