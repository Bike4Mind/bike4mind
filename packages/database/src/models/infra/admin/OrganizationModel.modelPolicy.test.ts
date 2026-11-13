import { describe, it, expect } from 'vitest';
import { readOrgModelPolicy } from '@bike4mind/common';
import { Organization, organizationRepository } from './OrganizationModel';
import { setupMongoTest } from '../../../__test__/utils';

const makeOrg = (extra: Record<string, unknown> = {}) =>
  Organization.create({ name: 'org', userId: 'owner', users: [], groups: [], ...extra });

describe('Organization modelPolicy', () => {
  setupMongoTest();

  it('reads an org with no stored policy as unrestricted', async () => {
    const org = await makeOrg();
    const stored = await organizationRepository.findById(String(org._id));
    expect(stored?.modelPolicy ?? null).toBeNull();
    expect(readOrgModelPolicy(stored?.modelPolicy)).toBeNull();
  });

  it('round-trips a policy, keeping an empty tool list distinct from an unrestricted one', async () => {
    const org = await makeOrg();
    await Organization.updateOne(
      { _id: org._id },
      { $set: { modelPolicy: { allowedProviders: ['openai'], allowedModels: null, allowedTools: [] } } }
    );
    const stored = await organizationRepository.findById(String(org._id));
    expect(readOrgModelPolicy(stored?.modelPolicy)).toEqual({
      allowedProviders: ['openai'],
      allowedModels: null,
      allowedTools: [],
    });
  });
});
