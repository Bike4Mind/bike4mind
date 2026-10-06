import { describe, it, expect, vi } from 'vitest';

import {
  CREATE_LAKE_SOURCES,
  GITHUB_CREATE_ORG_MANAGER_ONLY_REASON,
  GITHUB_CREATE_ORG_ONLY_REASON,
  createLakeOrigin,
  createSourceRequiresUpload,
  getCreateLakeSource,
  resolveCreateLakeSourceAvailability,
  type CreateLakeScope,
  type CreateLakeSourceKind,
} from './createLakeSources';

const flagOn = () => true;
const flagOff = () => false;
const availability = (kind: CreateLakeSourceKind, scope: CreateLakeScope, isEnabled = flagOn) =>
  resolveCreateLakeSourceAvailability(getCreateLakeSource(kind), scope, isEnabled);

const orgManager: CreateLakeScope = { organizationId: 'org-1', canManageOrg: true };
const orgMember: CreateLakeScope = { organizationId: 'org-1', canManageOrg: false };
const personal: CreateLakeScope = { canManageOrg: false };

describe('CREATE_LAKE_SOURCES', () => {
  it('offers upload, Drive and GitHub in that order', () => {
    expect(CREATE_LAKE_SOURCES.map(source => source.kind)).toEqual(['upload', 'googleDrive', 'github']);
  });
});

/**
 * The card decides the new lake's declared origin, which is what the connector bind doors check
 * (acceptsConnectorContent). A connector card that produced a curated lake would create a lake its
 * own next step refuses.
 */
describe('createLakeOrigin', () => {
  it('declares an upload lake curated and every connector lake connector-fed', () => {
    expect(createLakeOrigin('upload')).toBe('curated');
    expect(createLakeOrigin('googleDrive')).toBe('connector-fed');
    expect(createLakeOrigin('github')).toBe('connector-fed');
  });
});

describe('createSourceRequiresUpload', () => {
  it('asks for local files only for the upload card', () => {
    expect(createSourceRequiresUpload('upload')).toBe(true);
    expect(createSourceRequiresUpload('googleDrive')).toBe(false);
    expect(createSourceRequiresUpload('github')).toBe(false);
  });
});

describe('resolveCreateLakeSourceAvailability', () => {
  it('hides GitHub, but not the others, while EnableDataLakeGitHub is off', () => {
    expect(availability('github', orgManager, flagOff)).toEqual({ status: 'hidden' });
    expect(availability('upload', orgManager, flagOff)).toEqual({ status: 'available' });
    expect(availability('googleDrive', orgManager, flagOff)).toEqual({ status: 'available' });
  });

  it('asks the flag for the GitHub source by name', () => {
    const isEnabled = vi.fn(() => true);
    availability('github', orgManager, isEnabled);
    expect(isEnabled).toHaveBeenCalledWith('EnableDataLakeGitHub');
  });

  it('disables GitHub in a personal workspace, with the reason', () => {
    expect(availability('github', personal)).toEqual({
      status: 'disabled',
      reason: GITHUB_CREATE_ORG_ONLY_REASON,
    });
  });

  it('disables GitHub for an org member who cannot manage the org', () => {
    expect(availability('github', orgMember)).toEqual({
      status: 'disabled',
      reason: GITHUB_CREATE_ORG_MANAGER_ONLY_REASON,
    });
  });

  it('offers GitHub to an org owner/manager', () => {
    expect(availability('github', orgManager)).toEqual({ status: 'available' });
  });

  // Unlike GitHub's, drive-sync accepts a personal lake from its creator - the caller here - so the
  // card must not be gated on an org the server does not require.
  it('offers upload and Drive in every scope', () => {
    for (const scope of [orgManager, orgMember, personal]) {
      expect(availability('upload', scope)).toEqual({ status: 'available' });
      expect(availability('googleDrive', scope)).toEqual({ status: 'available' });
    }
  });
});
