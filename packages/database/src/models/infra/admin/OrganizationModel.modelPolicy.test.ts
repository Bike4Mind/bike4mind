import { describe, it, expect } from 'vitest';
import { INVALID_ORG_MODEL_POLICY, isModelAllowedByOrgPolicy, readOrgModelPolicy } from '@bike4mind/common';
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

  it.each([
    { allowedProviders: 'openai' },
    { allowedProviders: [1] },
    { allowedTools: 'web_search' },
    { allowedTools: [1] },
    { allowedProviders: [] },
    new Date('2026-01-01T00:00:00Z'),
    /openai/,
  ])('does not cast a malformed stored restriction into a valid policy: %j', async modelPolicy => {
    const org = await makeOrg();
    await Organization.collection.updateOne({ _id: org._id }, { $set: { modelPolicy } });
    const stored = await organizationRepository.findById(String(org._id));
    expect(stored?.modelPolicy).toEqual(modelPolicy);
    const read = readOrgModelPolicy(stored?.modelPolicy);
    expect(read).toBe(INVALID_ORG_MODEL_POLICY);
    expect(isModelAllowedByOrgPolicy(read, { id: 'tts-1' })).toBe(false);
  });

  it('retains obsolete provider and tool strings for repair without treating them as unrestricted', async () => {
    const org = await makeOrg({
      modelPolicy: { allowedProviders: ['retired-provider'], allowedTools: ['removed_tool'] },
    });
    const stored = await organizationRepository.findById(String(org._id));
    expect(readOrgModelPolicy(stored?.modelPolicy)).toEqual({
      allowedProviders: ['retired-provider'],
      allowedModels: null,
      allowedTools: ['removed_tool'],
    });
  });
});
