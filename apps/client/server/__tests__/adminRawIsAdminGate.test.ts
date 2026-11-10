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
 * Invariant: no `pages/api/admin` route gates on the raw flag unless it checks a permission
 * (`adminApi(`, or `requireAdminPermission(` / `hasAdminPermission(` on the admin branch of a route
 * that also serves non-admins), is in RAW_GATE_ALLOWLIST, or is in OUTSIDE_ADMIN_GATE. The allowlist
 * only shrinks: migrate a route, then delete its entry. Every entry must name a route that exists and
 * still gates raw, so a stale entry fails the suite.
 *
 * ADMIN_ROUTES_ELSEWHERE extends the scan to admin-only routes that live outside `pages/api/admin`.
 * Mixed-audience routes that branch on isAdmin for owner-or-admin logic are not listed: they use
 * requireAdminPermission() on their admin branch instead.
 */

const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'admin');

/**
 * Admin routes that run without a session (`auth: false`) and authenticate the caller themselves,
 * so no admin permission applies. Every `auth: false` route under `pages/api/admin` must be listed
 * here with its reason, so a new unauthenticated admin route cannot land unreviewed.
 */
const OUTSIDE_ADMIN_GATE = new Map<string, string>([
  ['emergency-login.ts', 'break-glass sign-in: reads the target account isAdmin, then requires its second factor'],
  ['rate-limits/ingest.ts', 'MCP Lambda push, authenticated by the rate-limit ingest token'],
  ['security-dashboard/attack-simulation-ingest.ts', 'scanner push, authenticated by its ingest token'],
  ['security-dashboard/cloud-prowler-ingest.ts', 'scanner push, authenticated by its ingest token'],
  ['security-dashboard/web-owasp-ingest.ts', 'scanner push, authenticated by its ingest token'],
  ['qa/report/[runId]/[token]/[...path].ts', 'report assets, authorized by the run-scoped token in the path'],
]);

const API_DIR = path.join(__dirname, '..', '..', 'pages', 'api');

const ADMIN_ROUTES_ELSEWHERE = [
  'auth/mfa/force-reset.ts',
  'inbox/admin-send.ts',
  'reg-invites/migrate.ts',
  'reg-invites/update.ts',
  'security/blocked-ips.ts',
  'security/blocked-ips/evaluate.ts',
  'settings/fetch.ts',
  'settings/index.ts',
  'settings/update.ts',
];

const RAW_GATE_ALLOWLIST = new Set<string>([
  'credit-adjustments.ts',
  'moderation-incidents/[id]/verdict.ts',
  'moderation-incidents/index.ts',
  'organizations/[id]/convert-to-paid.ts',
  'organizations/[id]/revoke.ts',
  'organizations/[id]/seats.ts',
  'organizations/[id]/top-up.ts',
  'organizations/grant.ts',
  'organizations/grants.ts',
  'subscriptions/[id]/admin-log.ts',
  'subscriptions/[id]/comp.ts',
  'subscriptions/[id]/index.ts',
  'subscriptions/[id]/sync.ts',
  'subscriptions/by-stripe/[stripeSubscriptionId].ts',
  'subscriptions/export.ts',
  'subscriptions/index.ts',
  'subscriptions/summary.ts',
  'users/[userId]/activity.ts',
  'users/[userId]/compliance.ts',
  'users/[userId]/credit-history.ts',
  'users/[userId]/credit-ledger-export.ts',
  'users/[userId]/credit-ledger.ts',
  'users/[userId]/credit-summary.ts',
  'users/[userId]/credit-transactions.ts',
  'users/[userId]/entitlements.ts',
  'users/[userId]/grant-subscription.ts',
  'users/[userId]/linked-accounts.ts',
  'users/[userId]/new-account-spend-cap.ts',
  'users/[userId]/profile.ts',
  'users/[userId]/risk-evidence.ts',
  'users/[userId]/sessions.ts',
  'users/[userId]/sign-ins.ts',
  'users/[userId]/signup-cluster.ts',
  'users/[userId]/subscriptions.ts',
  'users/[userId]/subscriptions/[subscriptionId]/credits.ts',
  'users/[userId]/subscriptions/[subscriptionId]/remove.ts',
  'users/[userId]/timeline.ts',
  // Receipts require full admin access, matching the credit ledger and summary routes.
  'users/[userId]/usage-receipt.ts',
  'users/export.ts',
  'users/index.ts',
  'users/summary.ts',
]);

// Helpers that gate on the raw flag internally, so a route calling them is raw-gated even
// though its own source never names isAdmin. Add any new helper that wraps isAdmin here.
const RAW_GATE_HELPER = /\bverifyOrgOwner\s*\(/;
const RAW_GATE =
  /\b(?:req\.user|user)\s*[?!]*\s*\.\s*isAdmin\b|\bensureAdmin\s*\(|\{[^}]*\bisAdmin\b[^}]*\}\s*=\s*(?:req\.)?user\b/;
const ADMIN_API_CALL = /\badminApi\s*(?:<[^>]*>)?\s*\(/;
const PERMISSION_GATE_CALL = /\b(?:adminApi\s*(?:<[^>]*>)?|requireAdminPermission|hasAdminPermission)\s*\(/;

/** Strings and comments are blanked first, so a quoted mention or a zod `isAdmin:` field is not a gate. */
export function usesRawIsAdminGate(source: string): boolean {
  const { code, terminated } = blankStringLiterals(source);
  if (!terminated) throw new Error('source ends inside a string, template or block comment');
  return (
    (RAW_GATE.test(code) && !ADMIN_API_CALL.test(code)) ||
    (RAW_GATE_HELPER.test(code) && !PERMISSION_GATE_CALL.test(code))
  );
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
    ['a destructured isAdmin', 'const { id, isAdmin } = req.user; if (!isAdmin) throw new Error();'],
  ])('flags %s', (_label, code) => {
    expect(usesRawIsAdminGate(`const handler = baseApi().get(async (req) => { ${code} });`)).toBe(true);
  });

  it.each([['verifyOrgOwner(', 'await verifyOrgOwner(req.user, organizationId);']])(
    'flags a route gated through the raw-flag helper %s',
    (_label, code) => {
      expect(usesRawIsAdminGate(`const handler = baseApi().get(async (req) => { ${code} });`)).toBe(true);
    }
  );

  it.each([
    ['adminApi(', "adminApi({ adminPermissions: { GET: 'settings:manage' } })"],
    ['a generic adminApi<Req, Res>(', "adminApi<Request, Response>({ adminPermissions: { GET: 'settings:manage' } })"],
  ])('does not flag a route that is gated by %s', (_label, gate) => {
    expect(usesRawIsAdminGate(`${gate}.get(async (req) => { if (req.user.isAdmin) log(); })`)).toBe(false);
  });

  it.each([
    ['requireAdminPermission(', "requireAdminPermission(req, 'support:read');"],
    ['hasAdminPermission(', "const admin = hasAdminPermission(req.user, 'support:read');"],
  ])('does not flag a route whose admin branch checks %s', (_label, check) => {
    const code = `baseApi().get(async (req) => { ${check} await verifyOrgOwner(req.user, orgId); });`;
    expect(usesRawIsAdminGate(code)).toBe(false);
  });

  it.each([
    ['requireAdminPermission(', "requireAdminPermission(req, 'support:read');"],
    ['hasAdminPermission(', "const admin = hasAdminPermission(req.user, 'support:read');"],
  ])('still flags a raw isAdmin gate beside %s', (_label, check) => {
    const code = `baseApi().get(async (req) => { ${check} if (!req.user.isAdmin) throw new Error(); });`;
    expect(usesRawIsAdminGate(code)).toBe(true);
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
    if (RAW_GATE_ALLOWLIST.has(name) || OUTSIDE_ADMIN_GATE.has(name)) return;
    expect(
      usesRawIsAdminGate(readFileSync(file, 'utf8')),
      `${name} gates on raw isAdmin; use adminApi() with a per-method adminPermissions entry`
    ).toBe(false);
  });

  it.each(ADMIN_ROUTES_ELSEWHERE)('pages/api/%s', name => {
    const file = path.join(API_DIR, name);
    expect(existsSync(file), `${name} no longer exists; remove it from ADMIN_ROUTES_ELSEWHERE`).toBe(true);
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

describe('admin routes outside the admin gate', () => {
  const UNAUTHENTICATED = /\bauth\s*:\s*false\b/;

  it('lists every unauthenticated admin route', () => {
    const unauthenticated = files
      .filter(f => UNAUTHENTICATED.test(blankStringLiterals(readFileSync(f, 'utf8')).code))
      .map(rel)
      .sort();
    expect(unauthenticated).toEqual([...OUTSIDE_ADMIN_GATE.keys()].sort());
  });
});
