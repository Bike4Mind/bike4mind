// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgApiKeyGrant } from '@bike4mind/common';
import { resolveOrgApiKeyReach } from './orgApiKeyReach';

const { mockFindByOrganization } = vi.hoisted(() => ({ mockFindByOrganization: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  groupRepository: { findByOrganization: mockFindByOrganization },
}));

const ORG_ID = 'a'.repeat(24);
const OTHER_ORG_ID = 'f'.repeat(24);
const GROUP_A = 'b'.repeat(24);
const GROUP_B = 'c'.repeat(24);
const FOREIGN_GROUP = 'd'.repeat(24);

const orgGrant = (resourceId: string): OrgApiKeyGrant => ({
  resourceType: 'organization',
  resourceId,
  permission: 'read',
});
const groupGrant = (resourceId: string): OrgApiKeyGrant => ({ resourceType: 'group', resourceId, permission: 'read' });

describe('resolveOrgApiKeyReach', () => {
  beforeEach(() => {
    mockFindByOrganization.mockReset();
    mockFindByOrganization.mockResolvedValue([{ id: GROUP_A }, { id: GROUP_B }]);
  });

  it('denies by default when there are no grants, without reading groups', async () => {
    await expect(resolveOrgApiKeyReach(ORG_ID, [])).resolves.toEqual({
      organizationId: ORG_ID,
      readGroupIds: [],
      dataLakeOrgIds: [],
    });
    expect(mockFindByOrganization).not.toHaveBeenCalled();
  });

  it('expands a whole-org grant to every live org group and the org lakes', async () => {
    await expect(resolveOrgApiKeyReach(ORG_ID, [orgGrant(ORG_ID)])).resolves.toEqual({
      organizationId: ORG_ID,
      readGroupIds: [GROUP_A, GROUP_B],
      dataLakeOrgIds: [ORG_ID],
    });
    expect(mockFindByOrganization).toHaveBeenCalledWith(ORG_ID);
  });

  it('keeps only granted groups that are live in the org and grants no lakes', async () => {
    await expect(resolveOrgApiKeyReach(ORG_ID, [groupGrant(GROUP_B), groupGrant(FOREIGN_GROUP)])).resolves.toEqual({
      organizationId: ORG_ID,
      readGroupIds: [GROUP_B],
      dataLakeOrgIds: [],
    });
  });

  it('ignores an organization grant naming another org', async () => {
    await expect(resolveOrgApiKeyReach(ORG_ID, [orgGrant(OTHER_ORG_ID)])).resolves.toEqual({
      organizationId: ORG_ID,
      readGroupIds: [],
      dataLakeOrgIds: [],
    });
    expect(mockFindByOrganization).not.toHaveBeenCalled();
  });

  it('drops a granted group once it is deleted from the org', async () => {
    mockFindByOrganization.mockResolvedValue([{ id: GROUP_A }]);
    const result = await resolveOrgApiKeyReach(ORG_ID, [groupGrant(GROUP_B)]);
    expect(result.readGroupIds).toEqual([]);
  });
});
