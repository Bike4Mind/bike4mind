import { describe, it, expect, vi } from 'vitest';
import { FIND_ACCESSIBLE_ARMS } from '@bike4mind/common';
import type { AccessContext, FindAccessibleArm } from '@bike4mind/common';
import { DataLakeModel, dataLakeRepository, buildAccessibleQuery } from './DataLakeModel';

/**
 * `findAccessible`'s access arms are hand-built into a Mongo `$or`, and a second, in-memory
 * hand-mirror of those same arms lives in the service layer's test fake
 * (`b4m-core/services/src/dataLakeService/dataLakeService.test.ts`, `ARM_COVERAGE` beside
 * `findAccessibleFake`). That fake carries the cross-org disclosure cases, which is a job it can
 * only do while it knows about every arm - and an arm added here would otherwise leave it quietly
 * asserting less than it claims, with a PASS either way.
 *
 * `FIND_ACCESSIBLE_ARMS` is the shared inventory that closes that gap; these are its
 * database-side teeth. They assert the arm LABELS, not the query semantics: what each arm admits
 * is pinned behaviorally, against real Mongo, in `DataLakeModel.test.ts` and the two
 * `*ScopeAgreement.test.ts` files. Nothing here needs a database.
 *
 * No frozen byte-for-byte filter matrix on purpose: `buildAccessibleQuery` was extracted out of
 * `findAccessible` unchanged, and that was verified by capturing the filter reaching
 * `DataLakeModel.find` for every row of `CONTEXTS` before and after the extraction and diffing
 * the two (identical). A committed copy of those literals would be a change-detector that fails
 * on any legitimate edit while the Mongo-backed suites above are what actually catch a behavior
 * change.
 */

const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'u1',
  isAdmin: false,
  userTags: ['alpha'],
  organizationIds: [],
  ...over,
});

type Opts = Parameters<typeof buildAccessibleQuery>[1];

const MAXIMAL = {
  name: 'the maximal non-admin caller',
  ctx: ctx({ organizationIds: ['o1'], administeredOrgIds: ['o3'], entitlementKeys: ['e-1'] }),
  opts: { grantedLakeIds: ['l1'], orgGrantedLakes: { o1: ['l2'] }, includePublic: true } satisfies Opts,
  arms: [...FIND_ACCESSIBLE_ARMS],
};

// Each row names the arms the built `$or` should carry, in order. The four conditional arms are
// each present in exactly one row and absent in another, so a condition inverted or dropped shows
// up here rather than only in a Mongo-backed behavior test.
const CONTEXTS: { name: string; ctx: AccessContext; opts?: Opts; arms: FindAccessibleArm[] }[] = [
  { name: 'a plain caller', ctx: ctx(), arms: ['owner', 'public', 'orgGate'] },
  {
    name: 'an org member',
    ctx: ctx({ organizationIds: ['o1', 'o2'] }),
    arms: ['owner', 'public', 'orgGate'],
  },
  {
    name: 'an org admin',
    ctx: ctx({ administeredOrgIds: ['o3'] }),
    arms: ['owner', 'public', 'orgGate', 'orgAdmin'],
  },
  {
    name: 'a grant holder',
    ctx: ctx(),
    opts: { grantedLakeIds: ['l1'] },
    arms: ['owner', 'public', 'orgGate', 'grant'],
  },
  {
    // One disjunct per granting org, so `orgGrant` is the one name that repeats - the parallelism
    // assertion below is what keeps the repeat honest.
    name: 'an org-grant holder in two orgs',
    ctx: ctx(),
    opts: { orgGrantedLakes: { o1: ['l1'], o2: ['l2', 'l3'] } },
    arms: ['owner', 'public', 'orgGate', 'orgGrant', 'orgGrant'],
  },
  {
    name: 'a management view (includePublic: false) drops the public and org-grant arms',
    ctx: ctx(),
    opts: { includePublic: false, orgGrantedLakes: { o1: ['l1'] } },
    arms: ['owner', 'orgGate'],
  },
  {
    name: 'empty administeredOrgIds/grantedLakeIds/orgGrantedLakes add no arm',
    ctx: ctx({ administeredOrgIds: [] }),
    opts: { grantedLakeIds: [], orgGrantedLakes: { o1: [] } },
    arms: ['owner', 'public', 'orgGate'],
  },
  MAXIMAL,
  // The isAdmin bypass replaces the whole $or instead of adding a disjunct, so it labels no arm -
  // and the parallelism assertion below still has to hold on it (0 arms, no $or).
  { name: 'an admin', ctx: ctx({ isAdmin: true }), arms: [] },
];

describe('buildAccessibleQuery - arm labelling', () => {
  it.each(CONTEXTS)('labels $name with the expected arms', ({ ctx: c, opts, arms }) => {
    expect(buildAccessibleQuery(c, opts).arms).toEqual(arms);
  });

  // A count check alone cannot see a label that has drifted off the disjunct it names, and the
  // labels are the whole product of this builder. One cheap shape probe per arm, each distinct
  // enough to reject any of the others.
  type Arm = Record<string, unknown>;
  const conjuncts = (a: Arm): Arm[] => (a.$and as Arm[] | undefined) ?? [];
  const SHAPE: Record<FindAccessibleArm, (a: Arm) => boolean> = {
    owner: a => 'createdByUserId' in a,
    public: a => conjuncts(a)[0]?.isPublic === true,
    orgGate: a => conjuncts(a).length === 3,
    orgAdmin: a => typeof a.organizationId === 'object' && !('_id' in a),
    grant: a => '_id' in a && !('organizationId' in a),
    orgGrant: a => '_id' in a && typeof a.organizationId === 'string',
  };

  it.each(CONTEXTS)('sits every label in front of the disjunct it names for $name', ({ ctx: c, opts }) => {
    const { filter, arms } = buildAccessibleQuery(c, opts);
    const or = (filter.$or as Arm[] | undefined) ?? [];
    // Fails on a disjunct pushed into the $or without a label (or labelled without being pushed),
    // and on a label/disjunct misalignment the counts agree about. If this fails, teach
    // `FIND_ACCESSIBLE_ARMS` about the new arm AND give ARM_COVERAGE in dataLakeService.test.ts a
    // position on it.
    expect(or.length).toBe(arms.length);
    arms.forEach((name, i) => expect(SHAPE[name](or[i])).toBe(true));
  });

  it('reaches every declared arm and declares every arm it reaches', () => {
    const reached = new Set<string>();
    for (const row of CONTEXTS) for (const arm of buildAccessibleQuery(row.ctx, row.opts).arms) reached.add(arm);
    expect([...reached].sort()).toEqual([...FIND_ACCESSIBLE_ARMS].sort());
  });

  it('is what findAccessible actually queries with', async () => {
    let captured: unknown;
    const spy = vi.spyOn(DataLakeModel, 'find').mockImplementation(((filter: unknown) => {
      captured = filter;
      return { select: () => [] } as never;
    }) as never);

    try {
      await dataLakeRepository.findAccessible(MAXIMAL.ctx, MAXIMAL.opts);
    } finally {
      // Without the finally, a throw above leaves the `find` spy installed for the rest of the file.
      spy.mockRestore();
    }

    // Without this, the guards above could hold on a builder the shipped method had stopped using.
    expect(captured).toEqual(buildAccessibleQuery(MAXIMAL.ctx, MAXIMAL.opts).filter);
  });
});
