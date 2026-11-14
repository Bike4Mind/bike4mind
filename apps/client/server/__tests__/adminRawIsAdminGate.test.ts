// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { blankStringLiterals } from './scopeCoverageHelpers';

/**
 * Admin access gates through `adminApi()` with a per-method permission so a delegated admin
 * (`adminPermissions`) is honoured. A route that gates on the raw `isAdmin` flag
 * (`req.user.isAdmin`, `ensureAdmin(`) locks delegates out and bypasses the permission model.
 *
 * Invariants, over every route under `pages/api`:
 * - No route gates on the raw flag unless it checks a permission (`adminApi(`, or
 *   `requireAdminPermission(` / `hasAdminPermission(` on the admin branch of a route that also serves
 *   non-admins), or is listed in OWNER_OR_ADMIN, FULL_ADMIN_ONLY or OUTSIDE_ADMIN_GATE with its reason.
 * - Every `pages/api/admin` route, and every route anywhere that calls `adminApi(`, declares a
 *   non-empty `adminPermissions` map, unless it is in OUTSIDE_ADMIN_GATE or PERMISSION_CHECKED_IN_HANDLER.
 *
 * Every list only shrinks, and every entry must name a route that exists and still matches, so a
 * stale entry fails the suite.
 */

const API_DIR = path.join(__dirname, '..', '..', 'pages', 'api');
const ADMIN_PREFIX = 'admin/';

/**
 * Admin routes that run without a session (`auth: false`) and authenticate the caller themselves,
 * so no admin permission applies. Every `auth: false` route under `pages/api/admin` must be listed
 * here with its reason, so a new unauthenticated admin route cannot land unreviewed.
 */
const OUTSIDE_ADMIN_GATE = new Map<string, string>([
  [
    'admin/emergency-login.ts',
    'break-glass sign-in: reads the target account isAdmin, then requires its second factor',
  ],
  ['admin/rate-limits/ingest.ts', 'MCP Lambda push, authenticated by the rate-limit ingest token'],
  ['admin/security-dashboard/attack-simulation-ingest.ts', 'scanner push, authenticated by its ingest token'],
  ['admin/security-dashboard/cloud-prowler-ingest.ts', 'scanner push, authenticated by its ingest token'],
  ['admin/security-dashboard/web-owasp-ingest.ts', 'scanner push, authenticated by its ingest token'],
  ['admin/qa/report/[runId]/[token]/[...path].ts', 'report assets, authorized by the run-scoped token in the path'],
]);

/**
 * `pages/api/admin` routes that are not built with `adminApi()` because their check depends on more
 * than the method. Each one still checks a permission (or a full admin) in its handler.
 */
const PERMISSION_CHECKED_IN_HANDLER = new Map<string, string>([
  ['admin/session-usage.ts', 'org owner reads own org; otherwise requireAdminPermission support:read'],
  ['admin/transactions.ts', 'org owner reads own ledger; verifyOrgAccess takes hasAdminPermission support:read'],
  ['admin/modal-tool.ts', 'CASL manage Modal, which settings:manage grants'],
  ['admin/llm-models/configurations.ts', 'GET serves every signed-in picker; PUT is assertFullAdmin on purpose'],
  ['admin/release-notes/index.ts', 'assertCanAdministerReleaseNotes also admits the release-notes:write job key'],
  ['admin/release-notes/[id].ts', 'assertCanAdministerReleaseNotes also admits the release-notes:write job key'],
]);

/**
 * Routes that serve ordinary users (owner, org member, author, self) where `isAdmin` only widens
 * access as an override, shapes the response, or is data rather than the caller's gate. These are
 * not admin gates, so they need no admin permission.
 */
const OWNER_OR_ADMIN = new Map<string, string>([
  ['agents/[id]/embed-keys.ts', 'agent owner or org admin may manage embed keys; admin also sees all keys'],
  ['agents/[id]/missions.ts', 'agent owner may view/own missions; admin overrides the access check'],
  ['ai/rapid-reply.ts', 'any user; admin only widens the Opti toggle bypass (isOpti), not a gate'],
  ['briefcase/catalog.ts', 'admin sees all system prompts; users see entitled ones'],
  ['briefcase/prompts/[id].ts', 'admin read visibility only; update/delete are owner-only'],
  [
    'data-lakes/batches/[batchId]/reanalyze-taxonomy.ts',
    'admin skips the daily taxonomy quota; lake access is checked separately',
  ],
  ['data-lakes/github-connect.ts', 'lake creator connects; isAdmin only shapes the audit actor'],
  ['deep-agent/agents/[agentId].ts', 'agent owner reads detail; admin may read any agent'],
  ['deep-agent/review.ts', 'admin-or-developer-tag gate (non-admin devs pass) plus owner-or-admin check'],
  ['deep-agent/spin.ts', 'admin-or-developer-tag gate (non-admin devs pass) plus owner-or-admin check'],
  ['email/resend-verification.ts', 'self-service; admin only gets a more detailed config error message'],
  ['feedback/index.ts', 'admin widens the list filter; users see readable feedback'],
  ['files/[id]/upload.ts', 'file owner uploads; isAdmin only passed to the static-tag write check'],
  ['files/generate-presigned-urls-batch.ts', 'any uploader; isAdmin only passed to the static-registry tag check'],
  ['help/chat.ts', 'any user asks; a full admin also retrieves admin-only help entries'],
  ['help/index.ts', 'any user reads the index; a full admin also sees admin-only entries'],
  ['image-templates/[id].ts', 'template owner CRUD; isAdmin forwarded to service'],
  ['image-templates/[id]/use.ts', 'owner records template use; isAdmin forwarded to service'],
  ['image-templates/index.ts', 'owner lists/creates templates; isAdmin forwarded to service'],
  ['inbox/[id]/delete.ts', 'receiver deletes own inbox item; admin may delete any'],
  ['inbox/read.ts', 'receiver marks own inbox read; admin may mark any'],
  ['memory/[kind]/[id].ts', 'lake owner deletes lake memory; admin override in canShredLakeMemory'],
  ['oauth/federated-admin.ts', "reports target user's isAdmin as data to a relying party; no caller admin gate"],
  ['organizations/[id]/github/connection.ts', 'org owner manages the org; verifyOrgOwner lets an admin through'],
  ['organizations/[id]/github/rate-limit.ts', 'org owner manages the org; verifyOrgOwner lets an admin through'],
  ['organizations/[id]/github/repositories.ts', 'org owner manages the org; verifyOrgOwner lets an admin through'],
  ['organizations/[id]/github/rotate-key.ts', 'org owner manages the org; verifyOrgOwner lets an admin through'],
  ['organizations/[id]/github/rotate-pat.ts', 'org owner manages the org; verifyOrgOwner lets an admin through'],
  ['organizations/[id]/github/test.ts', 'org owner manages the org; verifyOrgOwner lets an admin through'],
  [
    'organizations/[id]/integrations/slack/channels.ts',
    'org owner manages the org; verifyOrgOwner lets an admin through',
  ],
  [
    'organizations/[id]/integrations/slack/connect.ts',
    'org owner manages the org; verifyOrgOwner lets an admin through',
  ],
  ['organizations/[id]/integrations/slack/index.ts', 'org owner manages the org; verifyOrgOwner lets an admin through'],
  ['organizations/[id]/invoices.ts', 'org owner manages the org; verifyOrgOwner lets an admin through'],
  [
    'organizations/[id]/member-credit-budget.ts',
    'isAdmin only passed to toSafeOrganization; org authority checked in service',
  ],
  [
    'organizations/[id]/members/[userId]/credit-budget.ts',
    'isAdmin only passed to toSafeOrganization; org authority checked in service',
  ],
  ['organizations/[id]/members/[userId]/index.ts', 'isAdmin only passed to toSafeOrganization for response shaping'],
  ['organizations/[id]/members/[userId]/manager.ts', 'isAdmin only passed to toSafeOrganization for response shaping'],
  ['organizations/[id]/mfa-policy.ts', 'isAdmin only passed to toSafeOrganization for response shaping'],
  ['organizations/[id]/pendingUsers.ts', 'isAdmin only widens projection of returned users'],
  ['organizations/[id]/webhooks/github.ts', 'org owner manages the org; verifyOrgOwner lets an admin through'],
  [
    'organizations/[id]/webhooks/github/replay-dlq.ts',
    'org owner manages the org; verifyOrgOwner lets an admin through',
  ],
  [
    'organizations/[id]/webhooks/github/rotate-secret.ts',
    'org owner manages the org; verifyOrgOwner lets an admin through',
  ],
  ['organizations/[id]/webhooks/github/test.ts', 'org owner manages the org; verifyOrgOwner lets an admin through'],
  ['organizations/stats.ts', 'members see own orgs stats; admin sees all orgs'],
  ['organizations/subscriptions/subscribe.ts', 'org owner (verifyOrgOwner) subscribes the org'],
  ['organizations/subscriptions/update-seats.ts', 'billing owner or admin may change seats'],
  ['organizations/users.ts', 'org owner/manager reports; admin may pick another org via verifyOrgAccess'],
  [
    'publish/[publicId]/restore.ts',
    'owner or admin restores a published artifact; isAdmin also forwarded as actor flag',
  ],
  ['publish/[publicId]/revise.ts', 'owner or admin revises a published artifact'],
  ['publish/[publicId]/share-token.ts', 'owner or admin manages an artifact share token'],
  ['publish/annotations/[publicId].ts', 'any user comments; admins skip the per-author rate limit'],
  ['publish/annotations/[publicId]/[id].ts', 'author, artifact owner or admin edits/deletes an annotation'],
  ['publish/artifact/finalize.ts', 'creator or admin finalizes an upload; isAdmin passed to visibility checks'],
  ['publish/artifact/upload-url.ts', 'isAdmin only forwarded as actor flag to the publish access check'],
  ['publish/artifacts/[id].ts', 'owner or admin may manage a published artifact'],
  ['publish/artifacts/index.ts', 'admins see all artifacts in browse, users see own and live'],
  ['publish/fabfile.ts', 'file owner or admin may publish a file; isAdmin forwarded to access checks'],
  ['publish/reply.ts', 'session owner or admin may reply; isAdmin forwarded to access checks'],
  ['sessions/[id]/summary.ts', 'session owner summarizes; an admin may summarize any session'],
  ['skills/[id]/index.ts', 'skill owner or admin reads, edits, deletes via canEdit/canDelete helpers'],
  [
    'skills/index.ts',
    'admins also see system skills; create scope resolved via helper (admin may create system/org skills)',
  ],
  ['skills/market/[id]/index.ts', 'isAdmin only forwarded as actor flag to listing detail visibility'],
  [
    'skills/market/[id]/moderate.ts',
    'POST: super-admin or org admin of owning org delists/restores; org admins allowed',
  ],
  ['skills/market/[id]/report.ts', "isAdmin only makes an admin's report count toward auto-hide; any user may report"],
  ['skills/market/bundles/[id].ts', 'bundle owner or admin edits/deletes via helper'],
  ['skills/market/bundles/index.ts', 'isAdmin forwarded as actor flag to bundle list/create helpers'],
  ['skills/market/by-token/[token].ts', 'isAdmin only forwarded as actor flag when opening a listing by share token'],
  ['skills/market/by-token/index.ts', 'isAdmin only forwarded as actor flag when opening a listing by share token'],
  ['skills/market/me.ts', 'isAdmin reported as data (isReviewer/isAdmin flags) in a self-info response for the UI'],
  ['skills/market/suggest-tags.ts', 'isAdmin only lifts the per-minute rate limit to Infinity; tool open to all users'],
  ['skills/market/versions/[vid]/review.ts', 'reviewer is super-admin or org admin of owning org; org admins allowed'],
  ['slack/events.ts', 'webhook; isAdmin is Slack workspace admin status or copied into actor object'],
  ['stripe/webhook.ts', 'webhook; user.isAdmin read from dispute subject only to pick a Slack message'],
  ['usage/index.ts', 'org owner, self, or admin (support:read delegate) reads usage'],
  ['user-api-keys/index.ts', 'user mints own keys; org-billed minting allows org admin or platform admin'],
  ['users/[id]/agents.ts', 'self-or-admin: users act on own data, admin override'],
  ['users/[id]/collections/index.ts', 'self-or-admin: users act on own data, admin override'],
  ['users/[id]/confirm-photo.ts', 'self-or-admin: users act on own data, admin override'],
  ['users/[id]/docx-template.ts', 'self-or-admin: users act on own data, admin override'],
  ['users/[id]/email-settings.ts', 'self-or-admin: users act on own data, admin override'],
  ['users/[id]/friends.ts', 'self-or-admin: users act on own data, admin override'],
  ['users/[id]/index.ts', 'self or admin (with admin API-key scope) sees full profile'],
  ['users/[id]/ingested-emails.ts', 'self-or-admin: users act on own data, admin override'],
  ['users/[id]/organization.ts', 'self-or-admin: users act on own data, admin override'],
  ['users/[id]/organizations/index.ts', 'isAdmin only passed to toSafeOrganizations for response shaping'],
  ['users/[id]/projects.ts', 'self-or-admin: users act on own data, admin override'],
  ['users/[id]/slack-settings.ts', 'self-or-admin: users act on own data, admin override'],
  ['users/[id]/upload-photo.ts', 'self-or-admin: users act on own data, admin override'],
  ['users/activities/recent.ts', 'self-or-admin: users act on own data, admin override'],
  ['v1/skills/[id].ts', 'skill owner or admin access via helpers; isAdmin withheld from keys lacking admin scope'],
  ['v1/skills/index.ts', 'isAdmin forwarded to create-scope resolution; org admin or owner create paths'],
  ['v1/skills/market/listings/[id]/index.ts', 'isAdmin only forwarded as actor flag to listing detail visibility'],
  ['v1/skills/market/review-queue.ts', 'pending queue open to super-admin or org-admin reviewers via requireReviewer'],
  ['v1/skills/market/versions/[vid]/review.ts', 'reviewer is super-admin or org admin of owning org via decideVersion'],
  ['v1/skills/mine.ts', 'isAdmin forwarded to org access check for listing own skills'],
  ['webhooks/deliveries/[id]/retry.ts', 'delivery owner retries; admin may retry any'],
  ['webhooks/github/subscriptions/[id].ts', 'subscription owner manages; admin override'],
  ['webhooks/github/subscriptions/index.ts', 'org member creates subscriptions; admin may use any org'],
  ['webhooks/jira/subscriptions/[id].ts', 'subscription owner manages; admin override'],
  ['work-items/[id]/index.ts', 'org member updates work item; admin passes org access check'],
  ['work-items/index.ts', 'org member creates work item; admin passes org access check'],
]);

/**
 * Raw `isAdmin` gates that stay full-admin only, because no delegated permission fits yet. Fail
 * closed: a delegate is refused. Give one a permission, then delete its entry.
 */
const FULL_ADMIN_ONLY = new Map<string, string>([
  ['business-links/[id].ts', 'PUT and DELETE curate the shared business-link catalog; GET serves every user'],
  ['business-links/category/[id].ts', 'PUT and DELETE curate the business-link categories; GET serves every user'],
  ['business-links/category/index.ts', 'POST creates a business-link category; GET serves every user'],
  ['business-links/index.ts', 'POST adds a catalog business link; GET serves every user'],
  ['business-links/import.ts', 'POST bulk-imports the business-link catalog'],
  ['organizations/index.ts', 'POST creates an organization; GET lists the caller own orgs'],
  ['organizations/[id]/addUser.ts', 'adds any user to any org, which grants that org data; no permission covers it'],
  ['organizations/[id]/members/index.ts', 'POST adds a member directly, as addUser; GET and DELETE serve org managers'],
  ['organizations/[id]/index.ts', 'PUT ignores a currentCredits edit unless full admin; the rest serves the org owner'],
  ['users/index.ts', 'signup review and downloadAll export modes; the user picker serves every user'],
  ['skills/[id]/share.ts', 'only a full admin may set isGlobalRead or isGlobalWrite; owners share otherwise'],
  ['skills/market/review-queue.ts', 'filter=legacy audits pre-market global skills; other filters serve org reviewers'],
  ['help/content.ts', 'serves admin help articles; follows help/index and help/chat, which show them to full admins'],
]);

// Helpers that gate on the raw flag internally, so a route calling them is raw-gated even
// though its own source never names isAdmin. Add any new helper that wraps isAdmin here.
const RAW_GATE_HELPER = /\bverifyOrgOwner\s*\(/;
const RAW_GATE =
  /\b(?:req\.user|user)\s*[?!]*\s*\.\s*isAdmin\b|\bensureAdmin\s*\(|\{[^}]*\bisAdmin\b[^}]*\}\s*=\s*(?:req\.)?user\b/;
const ADMIN_API_CALL = /\badminApi\s*(?:<[^>]*>)?\s*\(/;
const PERMISSION_GATE_CALL = /\b(?:adminApi\s*(?:<[^>]*>)?|requireAdminPermission|hasAdminPermission)\s*\(/;
// `adminPermissions:` followed by anything but an empty object literal.
const DECLARED_PERMISSIONS = /\badminPermissions\s*:\s*(?!\{\s*\})\S/;

const codeOf = (source: string): string => {
  const { code, terminated } = blankStringLiterals(source);
  if (!terminated) throw new Error('source ends inside a string, template or block comment');
  return code;
};

/** Strings and comments are blanked first, so a quoted mention or a zod `isAdmin:` field is not a gate. */
export function usesRawIsAdminGate(source: string): boolean {
  const code = codeOf(source);
  return (
    (RAW_GATE.test(code) && !ADMIN_API_CALL.test(code)) ||
    (RAW_GATE_HELPER.test(code) && !PERMISSION_GATE_CALL.test(code))
  );
}

/** True when the route is built with `adminApi()` and names at least one per-method permission. */
export function declaresAdminPermission(source: string): boolean {
  const code = codeOf(source);
  return ADMIN_API_CALL.test(code) && DECLARED_PERMISSIONS.test(code);
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const rel = (f: string) => path.relative(API_DIR, f).split(path.sep).join('/');
const sources = new Map(routeFiles(API_DIR).map(f => [rel(f), readFileSync(f, 'utf8')]));
const routes = [...sources.keys()];
const adminRoutes = routes.filter(name => name.startsWith(ADMIN_PREFIX));
const sourceOf = (name: string): string => {
  const source = sources.get(name);
  if (source === undefined) throw new Error(`${name} no longer exists; remove its entry`);
  return source;
};
const isRawExempt = (name: string) =>
  OWNER_OR_ADMIN.has(name) || FULL_ADMIN_ONLY.has(name) || OUTSIDE_ADMIN_GATE.has(name);

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

describe('declaresAdminPermission', () => {
  it.each([
    ['a method map', "adminApi({ adminPermissions: { GET: 'support:read' } })"],
    ['a shared any-of list', 'adminApi({ adminPermissions: { GET: CREDITS_PAGE_READ } })'],
    ['a factory', "api: () => adminApi({ adminPermissions: { GET: 'settings:manage' }, auth: 'jwtOnly' })"],
  ])('accepts %s', (_label, code) => {
    expect(declaresAdminPermission(code)).toBe(true);
  });

  it.each([
    ['baseApi()', 'baseApi().get(handler)'],
    ['an empty map', 'adminApi({ adminPermissions: {} })'],
    ['a map named only in a comment', '// adminPermissions: { GET: x }\nadminApi(options)'],
  ])('rejects %s', (_label, code) => {
    expect(declaresAdminPermission(code)).toBe(false);
  });
});

describe('no route gates on the raw isAdmin flag', () => {
  it('scans every route under pages/api', () => {
    expect(adminRoutes.length).toBeGreaterThan(50);
    expect(routes.length).toBeGreaterThan(adminRoutes.length + 300);
    for (const covered of ['users/[id]/update.ts', 'users/[id]/delete.ts', 'users/[id]/loginAs.ts']) {
      expect(routes).toContain(covered);
    }
  });

  it.each(routes.filter(name => !isRawExempt(name)))('%s', name => {
    expect(
      usesRawIsAdminGate(sourceOf(name)),
      `${name} gates on raw isAdmin; use adminApi() with a per-method adminPermissions entry, ` +
        'or requireAdminPermission() on the admin branch of a mixed-audience route'
    ).toBe(false);
  });

  it.each([...OWNER_OR_ADMIN, ...FULL_ADMIN_ONLY])('exemption %s exists and still gates raw', (name, reason) => {
    expect(reason.trim()).not.toBe('');
    expect(usesRawIsAdminGate(sourceOf(name)), `${name} no longer gates on raw isAdmin; remove its exemption`).toBe(
      true
    );
  });

  it('keeps each route in one exemption list', () => {
    const listed = [...OWNER_OR_ADMIN.keys(), ...FULL_ADMIN_ONLY.keys(), ...OUTSIDE_ADMIN_GATE.keys()];
    expect(new Set(listed).size).toBe(listed.length);
  });

  it.each(['moderation-incidents/index.ts', 'moderation-incidents/[id]/verdict.ts', 'users/[userId]/usage-receipt.ts'])(
    'admin/%s uses adminApi without a redundant raw gate',
    name => {
      const code = codeOf(sourceOf(`${ADMIN_PREFIX}${name}`));
      expect(ADMIN_API_CALL.test(code)).toBe(true);
      expect(RAW_GATE.test(code)).toBe(false);
    }
  );

  it('keeps the organization ledger permission-aware for its mixed audience', () => {
    const source = sourceOf('admin/transactions.ts');
    expect(source).toMatch(
      /verifyOrg(?:Owner|Access)\(\s*\{\s*id:\s*req\.user\.id,\s*isAdmin:\s*hasAdminPermission\(req\.user,\s*'support:read'\)\s*\},\s*organizationId\s*\)/
    );
    expect(usesRawIsAdminGate(source)).toBe(false);
  });
});

describe('admin routes declare a permission', () => {
  const adminApiRoutes = routes.filter(name => ADMIN_API_CALL.test(codeOf(sourceOf(name))));
  const mustDeclare = [...new Set([...adminRoutes, ...adminApiRoutes])].filter(
    name => !OUTSIDE_ADMIN_GATE.has(name) && !PERMISSION_CHECKED_IN_HANDLER.has(name)
  );

  it('finds adminApi routes outside pages/api/admin', () => {
    expect(adminApiRoutes.filter(name => !name.startsWith(ADMIN_PREFIX)).length).toBeGreaterThan(10);
  });

  it.each(mustDeclare)('%s', name => {
    expect(
      declaresAdminPermission(sourceOf(name)),
      `${name} declares no admin permission; build it with adminApi({ adminPermissions: { METHOD: permission } })`
    ).toBe(true);
  });

  it.each([...PERMISSION_CHECKED_IN_HANDLER])('in-handler entry %s exists and is not on adminApi', (name, reason) => {
    expect(reason.trim()).not.toBe('');
    expect(ADMIN_API_CALL.test(codeOf(sourceOf(name))), `${name} is on adminApi now; remove its entry`).toBe(false);
  });
});

describe('admin routes outside the admin gate', () => {
  const UNAUTHENTICATED = /\bauth\s*:\s*false\b/;

  it('lists every unauthenticated admin route', () => {
    const unauthenticated = adminRoutes.filter(name => UNAUTHENTICATED.test(codeOf(sourceOf(name)))).sort();
    expect(unauthenticated).toEqual([...OUTSIDE_ADMIN_GATE.keys()].sort());
  });
});
