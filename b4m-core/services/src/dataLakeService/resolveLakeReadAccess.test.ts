import { describe, it, expect, vi } from 'vitest';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { classifyLakeAccess } from './classifyLakeAccess';
import {
  containedGrants,
  grantedLakeReachFor,
  grantedLakeReachForTurn,
  resolveReadGrant,
  resolveLakeReadAccess,
  resolveEnforceReadGrants,
  manageGrantedLakeIdsFor,
  ENFORCE_LAKE_READ_GRANTS_KEY,
  READ_GRANT_ENFORCEMENT_READY,
} from './resolveLakeReadAccess';
import type { LakeGrant } from './manageRule';

type LakeShape = Pick<
  IDataLakeDocument,
  'createdByUserId' | 'organizationId' | 'requiredUserTag' | 'requiredEntitlement' | 'isPublic'
>;

const lake = (over: Partial<LakeShape> = {}): LakeShape => ({
  createdByUserId: 'creator',
  organizationId: undefined,
  requiredUserTag: undefined,
  requiredEntitlement: undefined,
  isPublic: false,
  ...over,
});

const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'stranger',
  isAdmin: false,
  userTags: [],
  organizationIds: [],
  ...over,
});

const grant = (
  role: LakeGrant['role'],
  principalId = 'stranger',
  principalType: LakeGrant['principalType'] = 'user'
): LakeGrant => ({
  principalType,
  principalId,
  role,
});

describe('classifyLakeAccess - the five arms the cutover diffs against', () => {
  it('owner-admin: platform admin bypass', () => {
    expect(classifyLakeAccess(lake(), ctx({ isAdmin: true }))).toEqual({ allowed: true, arm: 'owner-admin' });
  });

  it('owner-admin: the creator', () => {
    expect(classifyLakeAccess(lake(), ctx({ userId: 'creator' }))).toEqual({ allowed: true, arm: 'owner-admin' });
  });

  it('public: gate-less public lake admits everyone', () => {
    expect(classifyLakeAccess(lake({ isPublic: true }), ctx())).toEqual({ allowed: true, arm: 'public' });
  });

  it('public: a gate added post-publish still holds (defense in depth)', () => {
    expect(classifyLakeAccess(lake({ isPublic: true, requiredUserTag: 'vip' }), ctx())).toEqual({
      allowed: false,
      arm: 'public',
    });
  });

  it('private-deny: no org, no gate -> owner/admin only', () => {
    expect(classifyLakeAccess(lake(), ctx())).toEqual({ allowed: false, arm: 'private-deny' });
  });

  it('org-prereq: org-scoped lake, caller not in the org', () => {
    expect(classifyLakeAccess(lake({ organizationId: 'orgA' }), ctx({ organizationIds: ['orgB'] }))).toEqual({
      allowed: false,
      arm: 'org-prereq',
    });
  });

  it('requirement: held tag admits; missing tag denies - same arm either way', () => {
    expect(classifyLakeAccess(lake({ requiredUserTag: 'vip' }), ctx({ userTags: ['vip'] }))).toEqual({
      allowed: true,
      arm: 'requirement',
    });
    expect(classifyLakeAccess(lake({ requiredUserTag: 'vip' }), ctx({ userTags: [] }))).toEqual({
      allowed: false,
      arm: 'requirement',
    });
  });

  it('widening guard: an in-org tag holder passes, an out-of-org tag holder does NOT', () => {
    const orgLake = lake({ organizationId: 'orgA', requiredUserTag: 'vip' });
    expect(classifyLakeAccess(orgLake, ctx({ userTags: ['vip'], organizationIds: ['orgA'] })).allowed).toBe(true);
    expect(classifyLakeAccess(orgLake, ctx({ userTags: ['vip'], organizationIds: ['orgB'] }))).toEqual({
      allowed: false,
      arm: 'org-prereq',
    });
  });
});

describe('resolveReadGrant - the new explicit read-grant arm (user + org principals)', () => {
  it('true for a user-principal grant matching the caller (any role)', () => {
    expect(resolveReadGrant(ctx(), [grant('reader')])).toBe(true);
  });

  it('true for an org-principal grant when the caller is a MEMBER of that org', () => {
    expect(
      resolveReadGrant(ctx({ userId: 'u1', organizationIds: ['orgA'] }), [grant('reader', 'orgA', 'organization')])
    ).toBe(true);
  });

  it('true for an org owner/curator grant reaching a plain member (read follows membership)', () => {
    const c = ctx({ userId: 'u1', organizationIds: ['orgA'] });
    expect(resolveReadGrant(c, [grant('owner', 'orgA', 'organization')])).toBe(true);
    expect(resolveReadGrant(c, [grant('curator', 'orgA', 'organization')])).toBe(true);
  });

  it('false for an org-principal grant when the caller is NOT a member of that org', () => {
    expect(
      resolveReadGrant(ctx({ userId: 'u1', organizationIds: ['orgB'] }), [grant('reader', 'orgA', 'organization')])
    ).toBe(false);
  });

  it('false for a grant belonging to a different user', () => {
    expect(resolveReadGrant(ctx({ userId: 'u1' }), [grant('reader', 'u2')])).toBe(false);
  });

  it('false when the caller has no userId (fails closed on a blank identity)', () => {
    expect(resolveReadGrant(ctx({ userId: '' }), [grant('reader', '')])).toBe(false);
  });
});

describe('resolveLakeReadAccess - report-only vs enforce', () => {
  const readerCtx = ctx({ userId: 'reader1' });
  const readerGrant = [grant('reader', 'reader1')];

  it('report-only: a reader grant DIVERGES but does not change access (returns legacy deny)', () => {
    const d = resolveLakeReadAccess(lake(), readerCtx, readerGrant, { enforceReadGrants: false });
    expect(d).toMatchObject({
      allowed: false, // enforced decision stays legacy in report-only
      legacyAllowed: false,
      legacyArm: 'private-deny',
      readGrantAllows: true,
      resolvedAllowed: true,
      diverges: true,
      enforced: false,
    });
  });

  it('enforce: the same reader grant now opens the private lake', () => {
    const d = resolveLakeReadAccess(lake(), readerCtx, readerGrant, { enforceReadGrants: true });
    expect(d).toMatchObject({ allowed: true, resolvedAllowed: true, diverges: true, enforced: true });
  });

  it('org grant to a member: diverges in report-only, opens under enforce', () => {
    // The lake must live in the granting org - an org grant is contained to it, so an org-less lake
    // is the wrong fixture for the membership question (see containedGrants).
    const orgLake = lake({ organizationId: 'orgA', requiredUserTag: 'TagMemberLacks' });
    const memberCtx = ctx({ userId: 'm1', organizationIds: ['orgA'] });
    const orgGrant = [grant('reader', 'orgA', 'organization')];
    expect(resolveLakeReadAccess(orgLake, memberCtx, orgGrant, { enforceReadGrants: false })).toMatchObject({
      allowed: false,
      readGrantAllows: true,
      diverges: true,
      enforced: false,
    });
    expect(resolveLakeReadAccess(orgLake, memberCtx, orgGrant, { enforceReadGrants: true }).allowed).toBe(true);
  });

  it('org grant to a NON-member: no divergence, stays denied', () => {
    const orgLake = lake({ organizationId: 'orgA' });
    const outsider = ctx({ userId: 'x1', organizationIds: ['orgB'] });
    const d = resolveLakeReadAccess(orgLake, outsider, [grant('reader', 'orgA', 'organization')], {
      enforceReadGrants: true,
    });
    // `legacyArm` pinned so the test records WHY legacy denied - non-membership, not a gate the
    // outsider happens to lack.
    expect(d).toMatchObject({
      allowed: false,
      readGrantAllows: false,
      diverges: false,
      legacyArm: 'org-prereq',
    });
  });

  it('owner grant does not diverge (already allowed by the legacy owner-admin arm)', () => {
    const d = resolveLakeReadAccess(lake(), readerCtx, [grant('owner', 'reader1')], { enforceReadGrants: false });
    expect(d).toMatchObject({ allowed: true, legacyArm: 'owner-admin', diverges: false });
  });

  it('no grant: a tag-matched lake is allowed by legacy, no divergence, in either mode', () => {
    const tagged = lake({ requiredUserTag: 'vip' });
    const c = ctx({ userId: 'u1', userTags: ['vip'] });
    expect(resolveLakeReadAccess(tagged, c, [], { enforceReadGrants: false })).toMatchObject({
      allowed: true,
      legacyArm: 'requirement',
      readGrantAllows: false,
      diverges: false,
    });
    expect(resolveLakeReadAccess(tagged, c, [], { enforceReadGrants: true }).allowed).toBe(true);
  });

  it('stranger with no grant is denied and does not diverge', () => {
    const d = resolveLakeReadAccess(lake(), ctx(), [], { enforceReadGrants: true });
    expect(d).toMatchObject({ allowed: false, diverges: false, legacyArm: 'private-deny' });
  });
});

describe('resolveEnforceReadGrants - fail-safe flag read', () => {
  it('unwired settings -> report-only (false)', async () => {
    expect(await resolveEnforceReadGrants(undefined)).toBe(false);
  });

  it('setting ON is gated by the code interlock: enforced only when READY, else report-only + warn', async () => {
    const settings = { getSettingsValue: vi.fn().mockResolvedValue(true) };
    const logger = { warn: vi.fn() };
    const result = await resolveEnforceReadGrants(settings, logger);
    expect(settings.getSettingsValue).toHaveBeenCalledWith(ENFORCE_LAKE_READ_GRANTS_KEY);
    // Enforced iff the source interlock is flipped; while it holds, a premature toggle stays
    // report-only and logs a warning so the accidental enable is visible.
    expect(result).toBe(READ_GRANT_ENFORCEMENT_READY);
    expect(logger.warn).toHaveBeenCalledTimes(READ_GRANT_ENFORCEMENT_READY ? 0 : 1);
  });

  it('a falsy value -> report-only', async () => {
    const settings = { getSettingsValue: vi.fn().mockResolvedValue(undefined) };
    expect(await resolveEnforceReadGrants(settings)).toBe(false);
  });

  it('a FAILED read degrades to report-only and warns (a failed read is not a yes)', async () => {
    const settings = { getSettingsValue: vi.fn().mockRejectedValue(new Error('boom')) };
    const logger = { warn: vi.fn() };
    expect(await resolveEnforceReadGrants(settings, logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('containedGrants - org containment asserted at read time', () => {
  const orgGrant = (orgId: string) => grant('reader', orgId, 'organization');

  it('drops an ORG grant naming an org that is not the lake own org', async () => {
    const rows = [orgGrant('orgA')];
    expect(containedGrants(lake({ organizationId: 'orgB' }), rows)).toEqual([]);
    expect(containedGrants(lake({ organizationId: 'orgA' }), rows)).toEqual(rows);
  });

  it('drops an ORG grant on an org-less (personal) lake - the writer refuses to create one', () => {
    // The read side matches the writer rather than being laxer than it: otherwise moving a lake
    // org -> personal leaves behind a grant this gate would honor forever, and lake deletion is the
    // only grant-removal path in the tree.
    const rows = [orgGrant('orgA')];
    expect(containedGrants(lake({ organizationId: undefined }), rows)).toEqual([]);
    expect(containedGrants(lake({ organizationId: '' }), rows)).toEqual([]);
  });

  it('never touches USER grants - those are meant to cross orgs (a transferred owner who moved)', () => {
    const rows = [grant('owner', 'u1'), grant('reader', 'u2')];
    expect(containedGrants(lake({ organizationId: 'orgB' }), rows)).toEqual(rows);
  });
});

describe('resolveLakeReadAccess - the org read arm is contained to the lake own org', () => {
  // The property the write path was supposed to hold (see resolveReadGrant): enforcement ships
  // before that writer exists, so the gate asserts it itself. A member of orgA holding an orgA
  // grant on a lake that belongs to orgB must not be admitted by the grant arm.
  const memberOfBoth = ctx({ userId: 'u1', organizationIds: ['orgA', 'orgB'] });

  it('denies a cross-org org grant, and admits the same grant on its own org lake', () => {
    const crossOrg = resolveLakeReadAccess(
      lake({ organizationId: 'orgB', requiredUserTag: 'TagIDoNotHold' }),
      ctx({
        userId: 'u1',
        organizationIds: ['orgA'],
      }),
      [grant('reader', 'orgA', 'organization')],
      { enforceReadGrants: true }
    );
    expect(crossOrg.readGrantAllows).toBe(false);
    expect(crossOrg.allowed).toBe(false);

    const sameOrg = resolveLakeReadAccess(
      lake({ organizationId: 'orgA', requiredUserTag: 'TagIDoNotHold' }),
      memberOfBoth,
      [grant('reader', 'orgA', 'organization')],
      { enforceReadGrants: true }
    );
    expect(sameOrg.readGrantAllows).toBe(true);
    expect(sameOrg.allowed).toBe(true);
  });
});

describe('grantedLakeReachFor - the two reach sets earn different bypasses', () => {
  const rows = (...rs: { dataLakeId: string; role: string; principalType: string; principalId: string }[]) => rs;
  const repo = (userRows: unknown[], orgRows: unknown[] = []) => ({
    listByPrincipal: vi.fn(async (type: string) => (type === 'user' ? userRows : orgRows)) as never,
  });

  it('splits user rows from org rows, and holds reader/org back until enforce', async () => {
    const grants = repo(
      rows(
        { dataLakeId: 'owned', role: 'owner', principalType: 'user', principalId: 'u1' },
        { dataLakeId: 'read', role: 'reader', principalType: 'user', principalId: 'u1' }
      ),
      rows({ dataLakeId: 'shared', role: 'reader', principalType: 'organization', principalId: 'orgA' })
    );

    const reportOnly = await grantedLakeReachFor('u1', ['orgA'], grants, false);
    expect(reportOnly).toEqual({ grantedLakeIds: ['owned'], orgGrantedLakes: {} });

    const enforced = await grantedLakeReachFor('u1', ['orgA'], grants, true);
    expect(enforced).toEqual({ grantedLakeIds: ['owned', 'read'], orgGrantedLakes: { orgA: ['shared'] } });
  });

  it('gives a lake reached both ways the stronger (unconditional) arm only', async () => {
    // Otherwise the org arm's org prerequisite would be the binding one for a lake the caller
    // also holds a user grant on, silently narrowing a bypass that is meant to cross orgs.
    const grants = repo(
      rows({ dataLakeId: 'both', role: 'owner', principalType: 'user', principalId: 'u1' }),
      rows({ dataLakeId: 'both', role: 'reader', principalType: 'organization', principalId: 'orgA' })
    );

    expect(await grantedLakeReachFor('u1', ['orgA'], grants, true)).toEqual({
      grantedLakeIds: ['both'],
      orgGrantedLakes: {},
    });
  });

  it('keys each org grant by the org that ISSUED it, for a caller who belongs to two', async () => {
    // The containment the repo arms rest on: flattening these into one id list asks the datastore
    // only "is the lake in ANY of my orgs", which an orgA grant on an orgB lake passes.
    const byOrg: Record<string, unknown[]> = {
      orgA: rows({ dataLakeId: 'lake-a', role: 'reader', principalType: 'organization', principalId: 'orgA' }),
      orgB: rows({ dataLakeId: 'lake-b', role: 'reader', principalType: 'organization', principalId: 'orgB' }),
    };
    const grants = {
      listByPrincipal: vi.fn(async (type: string, id: string) => (type === 'user' ? [] : (byOrg[id] ?? []))) as never,
    };

    expect(await grantedLakeReachFor('u1', ['orgA', 'orgB'], grants, true)).toEqual({
      grantedLakeIds: [],
      orgGrantedLakes: { orgA: ['lake-a'], orgB: ['lake-b'] },
    });
  });

  it('an unwired grant repo reaches nothing', async () => {
    expect(await grantedLakeReachFor('u1', ['orgA'])).toEqual({ grantedLakeIds: [], orgGrantedLakes: {} });
  });
});

/**
 * The memo exists because the knowledge tools resolve lake access per TOOL CALL, so a grounded turn
 * repeats this read 2..N times with byte-identical arguments. What is under test here is the KEY:
 * the retrieval and prompt-injection sites pass deliberately different arguments and are meant to
 * stay diverged permanently, so an entry they shared would be a silent widening, not a saved read.
 */
describe('grantedLakeReachForTurn - one read per turn per distinct argument set', () => {
  const row = (dataLakeId: string, role: string, principalType = 'user', principalId = 'u1') => ({
    dataLakeId,
    role,
    principalType,
    principalId,
  });
  const repo = () => ({
    listByPrincipal: vi.fn(async (type: string, id: string) =>
      type === 'user' ? [row('owned', 'owner')] : [row(`lake-${id}`, 'reader', 'organization', id)]
    ) as never,
  });
  const turn = () => ({});

  it('issues ONE read for two calls in the same turn, and returns the same reach', async () => {
    const grants = repo();
    const scope = turn();

    const first = await grantedLakeReachForTurn(scope, 'u1', [], grants, false);
    const second = await grantedLakeReachForTurn(scope, 'u1', [], grants, false);

    expect(first).toEqual({ grantedLakeIds: ['owned'], orgGrantedLakes: {} });
    expect(second).toEqual(first);
    expect(grants.listByPrincipal).toHaveBeenCalledTimes(1);
  });

  it('does NOT share an entry between two turns', async () => {
    const grants = repo();
    await grantedLakeReachForTurn(turn(), 'u1', [], grants, false);
    await grantedLakeReachForTurn(turn(), 'u1', [], grants, false);
    expect(grants.listByPrincipal).toHaveBeenCalledTimes(2);
  });

  it('does NOT share an entry across differing includeReaders, even in one turn', async () => {
    // Constraint the whole key exists for: injection pins `includeReaders: false` permanently,
    // retrieval follows the enforced cutover. A user-keyed memo would hand injection retrieval's
    // wider set - a reader's read access becoming authority to write another user's system prompt.
    const grants = repo();
    const scope = turn();

    const pinned = await grantedLakeReachForTurn(scope, 'u1', [], grants, false);
    const enforced = await grantedLakeReachForTurn(scope, 'u1', ['orgA'], grants, true);

    expect(pinned.orgGrantedLakes).toEqual({});
    expect(enforced.orgGrantedLakes).toEqual({ orgA: ['lake-orgA'] });
  });

  it('does NOT share an entry across differing organizationIds', async () => {
    const grants = repo();
    const scope = turn();

    const inA = await grantedLakeReachForTurn(scope, 'u1', ['orgA'], grants, true);
    const inB = await grantedLakeReachForTurn(scope, 'u1', ['orgB'], grants, true);

    expect(inA.orgGrantedLakes).toEqual({ orgA: ['lake-orgA'] });
    expect(inB.orgGrantedLakes).toEqual({ orgB: ['lake-orgB'] });
  });

  it('does NOT share an entry between two users in one turn', async () => {
    // A turn is one caller today, but the key must not rely on that: the scope object is a request
    // context, and a host that resolved two principals under one would otherwise cross them.
    const grants = {
      listByPrincipal: vi.fn(async (_type: string, id: string) => [row(`lake-${id}`, 'owner')]) as never,
    };
    const scope = turn();

    expect((await grantedLakeReachForTurn(scope, 'u1', [], grants, false)).grantedLakeIds).toEqual(['lake-u1']);
    expect((await grantedLakeReachForTurn(scope, 'u2', [], grants, false)).grantedLakeIds).toEqual(['lake-u2']);
  });

  it('collapses the same org set given in a different order', async () => {
    // The ids are sorted into the key, so caller-side ordering cannot split one entry in two - the
    // membership set is a set, and its resolver makes no ordering promise.
    const grants = repo();
    const scope = turn();

    await grantedLakeReachForTurn(scope, 'u1', ['orgA', 'orgB'], grants, true);
    await grantedLakeReachForTurn(scope, 'u1', ['orgB', 'orgA'], grants, true);

    // One user read plus one per membership org - the second call added none of them.
    expect(grants.listByPrincipal).toHaveBeenCalledTimes(3);
  });

  it('does not mutate the caller organizationIds while keying them', async () => {
    const grants = repo();
    const organizationIds = ['orgB', 'orgA'];
    await grantedLakeReachForTurn(turn(), 'u1', organizationIds, grants, true);
    expect(organizationIds).toEqual(['orgB', 'orgA']);
  });

  it('does not cache a rejected read: the next call re-reads rather than reporting no grants', async () => {
    // Otherwise one transient failure reads as "this user holds no grants" for the rest of the
    // turn, which every consumer takes as a settled deny.
    const grants = {
      listByPrincipal: vi
        .fn()
        .mockRejectedValueOnce(new Error('grants down'))
        .mockResolvedValue([row('owned', 'owner')]) as never,
    };
    const scope = turn();

    await expect(grantedLakeReachForTurn(scope, 'u1', [], grants, false)).rejects.toThrow('grants down');
    expect(await grantedLakeReachForTurn(scope, 'u1', [], grants, false)).toEqual({
      grantedLakeIds: ['owned'],
      orgGrantedLakes: {},
    });
  });

  it('an unwired grant repo still reaches nothing', async () => {
    expect(await grantedLakeReachForTurn(turn(), 'u1', ['orgA'])).toEqual({
      grantedLakeIds: [],
      orgGrantedLakes: {},
    });
  });

  it('lets the two sites share an entry when their arguments coincide', async () => {
    // Enforcement off and a caller in no org: retrieval and injection both pass `(false, [])`, so
    // one read serves both. Correct, not a widening - the floor is the arguments each site passes.
    const grants = repo();
    const scope = turn();

    const retrieval = await grantedLakeReachForTurn(scope, 'u1', [], grants, false);
    const injection = await grantedLakeReachForTurn(scope, 'u1', [], grants, false);

    expect(injection).toEqual(retrieval);
    expect(grants.listByPrincipal).toHaveBeenCalledTimes(1);
  });
});

describe('resolveEnforceReadGrants - the flag read collapses per turn only when scoped', () => {
  // No default for `value`: `settingsRepo(undefined)` must actually serve `undefined` (the
  // no-row case), which a parameter default would swallow into the default instead.
  const settingsRepo = (value: unknown) => ({
    getSettingsValue: vi.fn(async () => value) as never,
  });
  const turn = () => ({});

  it('reads the flag once per turn when given a scope', async () => {
    // AdminSettingsModel caches nothing, so an unscoped resolver running per tool call re-queries
    // Mongo for this flag every time.
    const settings = settingsRepo(true);
    const scope = turn();

    expect(await resolveEnforceReadGrants(settings, undefined, scope)).toBe(true);
    expect(await resolveEnforceReadGrants(settings, undefined, scope)).toBe(true);
    expect(settings.getSettingsValue).toHaveBeenCalledTimes(1);
  });

  it('still reads per call with no scope, so the once-per-request callers are unchanged', async () => {
    const settings = settingsRepo(true);
    await resolveEnforceReadGrants(settings);
    await resolveEnforceReadGrants(settings);
    expect(settings.getSettingsValue).toHaveBeenCalledTimes(2);
  });

  it('does NOT share the flag between two turns', async () => {
    const settings = settingsRepo(true);
    await resolveEnforceReadGrants(settings, undefined, turn());
    await resolveEnforceReadGrants(settings, undefined, turn());
    expect(settings.getSettingsValue).toHaveBeenCalledTimes(2);
  });

  it('does not cache the report-only answer a failed flag read produces', async () => {
    // The memo wraps the RAW read, so the throw still reaches the fail-safe catch on each attempt
    // and the rejection is evicted. Memoizing the resolved boolean instead would hold retrieval
    // narrowed to report-only for the rest of the turn on one transient failure.
    const settings = {
      getSettingsValue: vi.fn().mockRejectedValueOnce(new Error('settings down')).mockResolvedValue(true) as never,
    };
    const logger = { warn: vi.fn() };
    const scope = turn();

    expect(await resolveEnforceReadGrants(settings, logger, scope)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('enforce-flag read failed'), expect.any(Error));
    expect(await resolveEnforceReadGrants(settings, logger, scope)).toBe(true);
    expect(settings.getSettingsValue).toHaveBeenCalledTimes(2);
  });

  it('memoizes a falsy flag too, rather than re-reading it as a miss', async () => {
    // `undefined` (no row) and `false` are both legitimate settled answers - a memo that only
    // cached truthy values would leave the read un-collapsed on exactly the report-only install.
    const settings = settingsRepo(undefined);
    const scope = turn();

    expect(await resolveEnforceReadGrants(settings, undefined, scope)).toBe(false);
    expect(await resolveEnforceReadGrants(settings, undefined, scope)).toBe(false);
    expect(settings.getSettingsValue).toHaveBeenCalledTimes(1);
  });
});

/**
 * The two reaches, side by side on the SAME grant rows. The management views (archived/deleted/
 * transitional) offer only restore/cleanup/retry, so they must ask the manage reach; the browse and
 * read views ask the wide one. Compared directly rather than only through a list view because a
 * view also depends on which arms `findAccessible` keeps - this is where the reaches themselves
 * provably differ.
 */
describe('grant reach - read vs manage', () => {
  const repo = (rows: Record<string, { dataLakeId: string; role: string }[]>) => ({
    listByPrincipal: vi
      .fn()
      .mockImplementation(
        async (principalType: string, principalId: string) => rows[`${principalType}:${principalId}`] ?? []
      ),
  });

  it('the read reach admits a reader row under enforce; the manage reach never does', async () => {
    const rows = { 'user:me': [{ dataLakeId: 'lake1', role: 'reader' }] };

    // Called with includeReaders=true directly rather than through the setting, so this asserts the
    // reach's own contract rather than the cutover's current position.
    expect((await grantedLakeReachFor('me', [], repo(rows) as never, true)).grantedLakeIds).toEqual(['lake1']);
    expect(await manageGrantedLakeIdsFor('me', repo(rows) as never)).toEqual([]);
  });

  it('both reaches admit owner and curator rows', async () => {
    for (const role of ['owner', 'curator']) {
      const rows = { 'user:me': [{ dataLakeId: 'lake1', role }] };
      expect((await grantedLakeReachFor('me', [], repo(rows) as never, true)).grantedLakeIds).toEqual(['lake1']);
      expect(await manageGrantedLakeIdsFor('me', repo(rows) as never)).toEqual(['lake1']);
    }
  });

  it('the read reach resolves ORG-principal rows; the manage reach does not ask for them at all', async () => {
    const rows = { 'organization:orgA': [{ dataLakeId: 'lake1', role: 'owner' }] };
    const manageRepo = repo(rows);

    // Read reach: membership in the granting org resolves the row, keyed by that org so the repo
    // can AND it with the lake's own org.
    expect(await grantedLakeReachFor('me', ['orgA'], repo(rows) as never, true)).toEqual({
      grantedLakeIds: [],
      orgGrantedLakes: { orgA: ['lake1'] },
    });
    // Manage reach: a bare id list, so it carries no granting org and asks for no org rows. The
    // management views drop `orgGrantArms` anyway under includePublic:false.
    expect(await manageGrantedLakeIdsFor('me', manageRepo as never)).toEqual([]);
    expect(manageRepo.listByPrincipal).not.toHaveBeenCalledWith('organization', expect.anything(), expect.anything());
  });

  it('both degrade to an empty reach with no repo wired', async () => {
    expect(await grantedLakeReachFor('me', ['orgA'])).toEqual({ grantedLakeIds: [], orgGrantedLakes: {} });
    expect(await manageGrantedLakeIdsFor('me', undefined)).toEqual([]);
  });
});
