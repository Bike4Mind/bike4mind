import { describe, it, expect, vi } from 'vitest';

vi.mock('@client/app/components/DataLakeWizard/steps/DriveConnectAction', () => ({ default: () => null }));
vi.mock('@client/app/components/DataLakeWizard/steps/GitHubConnectAction', () => ({ default: () => null }));

import { DRIVE_PERSONAL_OWNER_ONLY_REASON } from '@client/app/components/DataLakeWizard/steps/DriveConnectUnavailableButton';
import {
  GITHUB_ORG_ONLY_REASON,
  LAKE_MANAGER_ONLY_REASON,
  LAKE_SOURCES,
  getLakeSource,
  resolveLakeSourceAvailability,
  type LakeSourceKind,
  type LakeSourceLake,
} from './lakeSources';

const flagOn = () => true;
const flagOff = () => false;
const availability = (kind: LakeSourceKind, lake: LakeSourceLake, isEnabled = flagOn) =>
  resolveLakeSourceAvailability(getLakeSource(kind), lake, isEnabled);

describe('LAKE_SOURCES', () => {
  it('lists Google Drive then GitHub', () => {
    expect(LAKE_SOURCES.map(source => source.kind)).toEqual(['googleDrive', 'github']);
  });
});

describe('resolveLakeSourceAvailability', () => {
  it('hides GitHub, but not Drive, while EnableDataLakeGitHub is off', () => {
    const lake = { organizationId: 'org-1', canManage: true };
    expect(availability('github', lake, flagOff)).toEqual({ status: 'hidden' });
    expect(availability('googleDrive', lake, flagOff)).toEqual({ status: 'available' });
  });

  it('asks the flag for the GitHub source by name', () => {
    const isEnabled = vi.fn(() => true);
    availability('github', { organizationId: 'org-1', canManage: true }, isEnabled);
    expect(isEnabled).toHaveBeenCalledWith('EnableDataLakeGitHub');
  });

  it('disables GitHub on a personal lake, even for its creator', () => {
    expect(availability('github', { organizationId: null, isCreator: true })).toEqual({
      status: 'disabled',
      reason: GITHUB_ORG_ONLY_REASON,
    });
  });

  it('keeps Drive on a personal lake for its creator only', () => {
    expect(availability('googleDrive', { organizationId: null, isCreator: true })).toEqual({ status: 'available' });
    expect(availability('googleDrive', { organizationId: null, isCreator: false })).toEqual({
      status: 'disabled',
      reason: DRIVE_PERSONAL_OWNER_ONLY_REASON,
    });
  });

  it('disables both sources for an org member who cannot manage the lake', () => {
    const lake = { organizationId: 'org-1', canManage: false };
    const expected = { status: 'disabled', reason: LAKE_MANAGER_ONLY_REASON };
    expect(availability('googleDrive', lake)).toEqual(expected);
    expect(availability('github', lake)).toEqual(expected);
  });

  it('offers both sources to an org lake manager', () => {
    const lake = { organizationId: 'org-1', canManage: true };
    expect(availability('googleDrive', lake)).toEqual({ status: 'available' });
    expect(availability('github', lake)).toEqual({ status: 'available' });
  });

  it('fails closed when manage and creator status are missing', () => {
    expect(availability('googleDrive', { organizationId: 'org-1' })).toEqual({
      status: 'disabled',
      reason: LAKE_MANAGER_ONLY_REASON,
    });
    expect(availability('github', { organizationId: 'org-1' })).toEqual({
      status: 'disabled',
      reason: LAKE_MANAGER_ONLY_REASON,
    });
    expect(availability('googleDrive', {})).toEqual({ status: 'disabled', reason: DRIVE_PERSONAL_OWNER_ONLY_REASON });
    expect(availability('github', {})).toEqual({ status: 'disabled', reason: GITHUB_ORG_ONLY_REASON });
  });
});
