import { describe, expect, it } from 'vitest';
import {
  MAX_ORG_API_KEY_GRANTS,
  OrgApiKeyGrantSchema,
  OrgApiKeyGrantsSchema,
  attachOrgApiKeyReach,
  orgApiKeyReachOf,
  readableGroupIds,
  type OrgApiKeyReach,
} from './orgApiKeyReach';

const ORG_ID = 'a'.repeat(24);
const GROUP_A = 'b'.repeat(24);
const GROUP_B = 'c'.repeat(24);

const reach = (readGroupIds: string[]): OrgApiKeyReach => ({
  organizationId: ORG_ID,
  readGroupIds,
  dataLakeOrgIds: [ORG_ID],
});

describe('OrgApiKeyGrantSchema', () => {
  it('accepts organization and group read grants', () => {
    expect(
      OrgApiKeyGrantSchema.safeParse({ resourceType: 'organization', resourceId: ORG_ID, permission: 'read' }).success
    ).toBe(true);
    expect(
      OrgApiKeyGrantSchema.safeParse({ resourceType: 'group', resourceId: GROUP_A, permission: 'read' }).success
    ).toBe(true);
  });

  it('rejects a non-hex or wrong-length resource id', () => {
    expect(
      OrgApiKeyGrantSchema.safeParse({ resourceType: 'group', resourceId: 'z'.repeat(24), permission: 'read' }).success
    ).toBe(false);
    expect(
      OrgApiKeyGrantSchema.safeParse({ resourceType: 'group', resourceId: 'abc', permission: 'read' }).success
    ).toBe(false);
  });

  it('rejects any permission other than read', () => {
    expect(
      OrgApiKeyGrantSchema.safeParse({ resourceType: 'group', resourceId: GROUP_A, permission: 'write' }).success
    ).toBe(false);
  });

  it('rejects an unknown resource type', () => {
    expect(
      OrgApiKeyGrantSchema.safeParse({ resourceType: 'project', resourceId: GROUP_A, permission: 'read' }).success
    ).toBe(false);
  });
});

describe('OrgApiKeyGrantsSchema', () => {
  const grant = { resourceType: 'group', resourceId: GROUP_A, permission: 'read' } as const;

  it(`accepts up to ${MAX_ORG_API_KEY_GRANTS} grants and rejects more`, () => {
    expect(OrgApiKeyGrantsSchema.safeParse(Array.from({ length: MAX_ORG_API_KEY_GRANTS }, () => grant)).success).toBe(
      true
    );
    expect(
      OrgApiKeyGrantsSchema.safeParse(Array.from({ length: MAX_ORG_API_KEY_GRANTS + 1 }, () => grant)).success
    ).toBe(false);
  });
});

describe('orgApiKeyReachOf', () => {
  it('returns undefined for a nullish user or one without a reach', () => {
    expect(orgApiKeyReachOf(null)).toBeUndefined();
    expect(orgApiKeyReachOf(undefined)).toBeUndefined();
    expect(orgApiKeyReachOf({ groups: [] })).toBeUndefined();
  });

  it('returns the attached reach', () => {
    const attached = reach([GROUP_A]);
    const user = attachOrgApiKeyReach({ groups: [] as string[] }, attached);
    expect(orgApiKeyReachOf(user)).toBe(attached);
  });

  it('does not survive a spread or a JSON round trip', () => {
    const user = attachOrgApiKeyReach({ id: 'u1', groups: [] as string[] }, reach([GROUP_A]));
    expect(Object.keys(user)).toEqual(['id', 'groups']);
    expect(orgApiKeyReachOf({ ...user })).toBeUndefined();
    expect(orgApiKeyReachOf(JSON.parse(JSON.stringify(user)) as object)).toBeUndefined();
  });

  it('can be replaced by a later attach', () => {
    const user = attachOrgApiKeyReach({ groups: [] as string[] }, reach([GROUP_A]));
    attachOrgApiKeyReach(user, reach([GROUP_B]));
    expect(orgApiKeyReachOf(user)?.readGroupIds).toEqual([GROUP_B]);
  });
});

describe('readableGroupIds', () => {
  it('returns the user own groups when no reach is attached', () => {
    expect(readableGroupIds({ groups: [GROUP_A] })).toEqual([GROUP_A]);
    expect(readableGroupIds({ groups: null })).toEqual([]);
    expect(readableGroupIds({})).toEqual([]);
  });

  it('unions the own groups with the granted ones and dedupes', () => {
    const user = attachOrgApiKeyReach({ groups: [GROUP_A] }, reach([GROUP_A, GROUP_B, GROUP_B]));
    expect(readableGroupIds(user).sort()).toEqual([GROUP_A, GROUP_B].sort());
  });

  it('does not alias the user groups array', () => {
    const groups = [GROUP_A];
    const result = readableGroupIds({ groups });
    result.push(GROUP_B);
    expect(groups).toEqual([GROUP_A]);
  });

  it('falls back to own groups on a spread copy of a reach-carrying user', () => {
    const user = attachOrgApiKeyReach({ groups: [] as string[] }, reach([GROUP_A]));
    expect(readableGroupIds(user)).toEqual([GROUP_A]);
    expect(readableGroupIds({ ...user })).toEqual([]);
  });
});
