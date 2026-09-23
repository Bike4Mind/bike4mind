// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * `requiredScopes` is opt-in and defaults open (baseApi with no gate calls
 * `apiKeyAuth(undefined)`), so an admin route that forgets it is reachable by ANY
 * valid API key of an owner who can already reach it - the confinement the ADMIN gate
 * adds on top of the in-handler `isAdmin`/`ability.can` check. Nothing else fails when a
 * new admin route simply says `baseApi()`, so a source scan is the only guard that
 * survives someone adding the next admin route. Mirrors dataLakeApiKeyScopeCoverage.test.ts.
 *
 * Two invariants:
 *  1. Every gated admin route stays gated with EXACTLY `[ApiKeyScope.ADMIN]` - remove the
 *     gate from one and it drops off the gated set into KNOWN_UNGATED, which it is not on,
 *     so this fails.
 *  2. A NEW admin route must either carry the gate or be added to KNOWN_UNGATED with intent.
 *     KNOWN_UNGATED is the ledger of admin routes still relying only on the in-handler admin
 *     check (defense-in-depth gate not yet applied); it only shrinks. It is deliberately
 *     enumerated by hand so widening it is a reviewable claim, not a silent regression.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route and
// pulls the project into the server Lambda (eslint no-restricted-syntax guards it).
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'admin');

// The gate every admin route should carry. Matches the declaration wherever it sits in the
// baseApi options (routes mix in `auth: true`, `rateLimit`, etc.), but pins the array to exactly
// `[ApiKeyScope.ADMIN]` so a route that swaps in a weaker/other scope is not accepted as "gated".
const ADMIN_GATE = /requiredScopes:\s*\[\s*ApiKeyScope\.ADMIN\s*\]/;

/**
 * Admin routes that gate admin access with an in-handler `isAdmin`/`ability.can` check but
 * do NOT yet declare the `[ApiKeyScope.ADMIN]` API-key gate. This is the remaining surface of
 * the scope-confinement rollout, tracked here so it is auditable and can only shrink: gating
 * one removes it from this list (see the stale-entry check below), and a new admin route may
 * NOT be added here without a deliberate edit. Do not grow this list to silence the test for a
 * new route - gate the route instead.
 */
const KNOWN_UNGATED = new Set<string>([
  'agent-executions/cleanup.ts',
  'agent-executions/stuck.ts',
  'agent-ops-settings.ts',
  'agent-ops-settings/repair.ts',
  'agent-ops-settings/seed.ts',
  'agent-ops-settings/versions/[version]/activate.ts',
  'agent-ops-settings/versions/index.ts',
  'analytics.ts',
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
  'dlq/history.ts',
  'dlq/messages.ts',
  'dlq/queues.ts',
  'dlq/replay.ts',
  'emergency-login.ts',
  'gears/[key].ts',
  'gears/index.ts',
  'generate-highlights.ts',
  'github/connection.ts',
  'github/rate-limit.ts',
  'github/repositories.ts',
  'github/rotate-key.ts',
  'github/test.ts',
  'help-analytics.ts',
  'integration-audit-logs/index.ts',
  'integration-health-dashboard.ts',
  'liveops-triage-configs/[id].ts',
  'liveops-triage-configs/[id]/health.ts',
  'liveops-triage-configs/[id]/trigger.ts',
  'liveops-triage-configs/index.ts',
  'liveops-triage-configs/runs.ts',
  'liveops-triage-env.ts',
  'liveops-triage/status/[jobId].ts',
  'liveops-triage/submit.ts',
  'llm-models/configurations.ts',
  'modals/variants.ts',
  'model-deprecation-status.ts',
  'model-discovery.ts',
  'model-logs.ts',
  'model-metrics.ts',
  'model-prices.ts',
  'operations-model.ts',
  'organizations/[id]/convert-to-paid.ts',
  'organizations/[id]/group-types.ts',
  'organizations/[id]/reconcile-seats.ts',
  'organizations/[id]/revoke.ts',
  'organizations/[id]/seats.ts',
  'organizations/grants.ts',
  'overwatch/backfill-first-seen.ts',
  'partner-signup-rules/[id].ts',
  'partner-signup-rules/backfill.ts',
  'partner-signup-rules/index.ts',
  'pr-report/generate.ts',
  'pr-report/send.ts',
  'published-artifacts/[id]/reports.ts',
  'published-artifacts/[id]/takedown.ts',
  'published-artifacts/index.ts',
  'rapid-reply/mappings/[id].ts',
  'rapid-reply/mappings/bulk.ts',
  'rapid-reply/mappings/index.ts',
  'rapid-reply/metrics.ts',
  'rapid-reply/prompts/[id].ts',
  'rapid-reply/prompts/[id]/activate.ts',
  'rapid-reply/prompts/index.ts',
  'rapid-reply/test.ts',
  'rate-limits.ts',
  'rate-limits/ingest.ts',
  'recalculate-message-counts.ts',
  'security-dashboard/attack-simulation-ingest.ts',
  'security-dashboard/cloud-prowler-ingest.ts',
  'security-dashboard/code-semgrep-ingest.ts',
  'security-dashboard/packages-ingest.ts',
  'security-dashboard/secrets-ingest.ts',
  'security-dashboard/web-owasp-ingest.ts',
  'security-scan-schedule/[scanType].ts',
  'security-scan-schedules/index.ts',
  'slack-app/create.ts',
  'slack-app/manifest-status.ts',
  'slack-app/reconnect.ts',
  'slack-app/update-manifest.ts',
  'slack-audit-logs/index.ts',
  'slack-workspaces.ts',
  'spend-reconciliation.ts',
  'system-health.ts',
  'system-health/integration-health.ts',
  'system-health/test-database.ts',
  'system-health/test-email.ts',
  'system-health/test-oauth.ts',
  'system-prompts/[promptId].ts',
  'system-prompts/[promptId]/create-version.ts',
  'system-prompts/[promptId]/history.ts',
  'system-prompts/[promptId]/reset.ts',
  'system-prompts/[promptId]/save-version.ts',
  'system-prompts/[promptId]/switch-version.ts',
  'system-prompts/[promptId]/test.ts',
  'system-prompts/index.ts',
  'system-secrets/[id].ts',
  'system-secrets/index.ts',
  'system-secrets/tier1-status.ts',
  'team-members.ts',
  'tool-definitions/[toolId].ts',
  'tool-definitions/index.ts',
  'upload-logo.ts',
  'usage-by-source.ts',
  'user-api-keys/[id]/rate-limit.ts',
  'user-api-keys/[id]/reset-rate-limit.ts',
  'users/[userId]/compliance.ts',
  'users/[userId]/entitlements.ts',
  'users/[userId]/resend-email-change.ts',
  'users/[userId]/resend-verification.ts',
  'users/[userId]/subscriptions.ts',
  'users/[userId]/subscriptions/[subscriptionId]/remove.ts',
  'users/[userId]/unverify-email.ts',
  'users/[userId]/user-api-keys.ts',
  'users/[userId]/verify-email.ts',
  'users/email-verification.ts',
  'voice-agents/[id].ts',
  'voice-agents/index.ts',
  'webhook-logs/[deliveryId].ts',
  'webhook-logs/index.ts',
  'webhook-logs/stats.ts',
  'whats-new-backfill.ts',
  'whats-new-config.ts',
  'whats-new-config/history.ts',
  'whats-new-config/preview.ts',
  'whats-new-config/restore.ts',
  'whats-new-generation-status.ts',
  'whats-new-highlights-config.ts',
  'whats-new-highlights-preview.ts',
  'whats-new/available.ts',
  'whats-new/config.ts',
  'whats-new/import.ts',
  'whats-new/sync.ts',
]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const files = routeFiles(ROUTES_DIR);
const rel = (f: string) => path.relative(ROUTES_DIR, f).split(path.sep).join('/');
// Strip line comments first so a commented-out gate (`// requiredScopes: [ApiKeyScope.ADMIN]`)
// does not read as gated. The declaration is often inline in the baseApi options, so the
// regex itself stays unanchored; removing comments is what prevents the false positive.
const isGated = (f: string) => ADMIN_GATE.test(readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, ''));

describe('admin routes declare the ADMIN API-key scope gate', () => {
  it('finds the admin route files', () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it.each(files.map(f => [rel(f), f]))('%s', (r, f) => {
    if (isGated(f)) return;
    // Ungated: allowed only if it is a known, deliberately-tracked route. A new admin route
    // that is neither gated nor listed fails here - gate it, or (rarely) add it to KNOWN_UNGATED.
    expect(
      KNOWN_UNGATED.has(r),
      `admin route "${r}" has no requiredScopes gate. Add ` +
        `baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }), or if it is intentionally left on the ` +
        `in-handler admin check only, add "${r}" to KNOWN_UNGATED with intent.`
    ).toBe(true);
  });

  it('has no stale KNOWN_UNGATED entries (a listed route that got gated or removed)', () => {
    const present = new Set(files.map(rel));
    const stale = [...KNOWN_UNGATED].filter(r => !present.has(r) || isGated(path.join(ROUTES_DIR, r)));
    expect(stale, `these KNOWN_UNGATED entries are now gated or gone - remove them from the list`).toEqual([]);
  });
});
