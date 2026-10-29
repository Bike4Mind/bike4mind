// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { blankStringLiterals } from './scopeCoverageHelpers';

/**
 * Admin routes gate through `adminApi()` with a per-method permission so a delegated admin
 * (`adminPermissions`) is honoured. A route that gates on the raw `isAdmin` flag
 * (`req.user.isAdmin`, `ensureAdmin(`) locks delegates out and bypasses the permission model.
 *
 * Invariant: no `pages/api/admin` route gates on the raw flag unless it calls `adminApi(` or is in
 * RAW_GATE_ALLOWLIST. The allowlist only shrinks: migrate a route, then delete its entry. Every
 * entry must name a route that exists and still gates raw, so a stale entry fails the suite.
 */

const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'admin');

const RAW_GATE_ALLOWLIST = new Set<string>([
  'abuse/bulk-execute.ts',
  'abuse/bulk-preview.ts',
  'activity-summary.ts',
  'agent-ops-settings.ts',
  'analytics.ts',
  'api-keys/scope-preflight.ts',
  'bulk-create-users.ts',
  'context-telemetry.ts',
  'create-user.ts',
  'credit-adjustments.ts',
  'embedding-limits.ts',
  'emergency-login.ts',
  'event-metrics.ts',
  'generate-highlights.ts',
  'help-analytics.ts',
  'integration-health-dashboard.ts',
  'liveops-triage-env.ts',
  'llm-models/configurations.ts',
  'model-deprecation-status.ts',
  'model-discovery.ts',
  'model-logs.ts',
  'model-metrics.ts',
  'model-prices.ts',
  'moderation-incidents/[id]/verdict.ts',
  'moderation-incidents/index.ts',
  'operations-model.ts',
  'organizations/[id]/convert-to-paid.ts',
  'organizations/[id]/group-types.ts',
  'organizations/[id]/reconcile-seats.ts',
  'organizations/[id]/revoke.ts',
  'organizations/[id]/seats.ts',
  'organizations/[id]/top-up.ts',
  'organizations/grant.ts',
  'organizations/grants.ts',
  'platform-usage.ts',
  'provider-invoices.ts',
  'published-artifacts/[id]/reports.ts',
  'published-artifacts/[id]/takedown.ts',
  'published-artifacts/index.ts',
  'rate-limits.ts',
  'recalculate-message-counts.ts',
  'release-notes/[id].ts',
  'release-notes/[id]/status.ts',
  'release-notes/config.ts',
  'release-notes/index.ts',
  'retrieval-rate.ts',
  'saved-views/[id].ts',
  'saved-views/index.ts',
  'session-usage.ts',
  'sessions/[id]/index.ts',
  'sessions/[id]/quests.ts',
  'signup-anomaly.ts',
  'signup-domain-holds.ts',
  'signup-risk-reviews.ts',
  'signup-timeseries.ts',
  'spend-reconciliation.ts',
  'spend.ts',
  'subscriptions/export.ts',
  'subscriptions/index.ts',
  'subscriptions/summary.ts',
  'system-health.ts',
  'system-secrets/[id].ts',
  'system-secrets/index.ts',
  'system-secrets/tier1-status.ts',
  'team-members.ts',
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
  'whats-new-highlights-config.ts',
  'whats-new-highlights-preview.ts',
]);

// Helpers that gate on the raw flag internally, so a route calling them is raw-gated even
// though its own source never names isAdmin. Add any new helper that wraps isAdmin here.
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

  it.each([...RAW_GATE_ALLOWLIST])('allowlist entry %s exists and still gates raw', name => {
    const file = path.join(ROUTES_DIR, name);
    expect(existsSync(file), `${name} no longer exists; remove it from RAW_GATE_ALLOWLIST`).toBe(true);
    expect(
      usesRawIsAdminGate(readFileSync(file, 'utf8')),
      `${name} no longer gates on raw isAdmin; remove it from RAW_GATE_ALLOWLIST`
    ).toBe(true);
  });
});
