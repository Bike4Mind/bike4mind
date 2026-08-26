import { describe, it, expect } from 'vitest';
import { isPublicArtifact, canUserReadArtifact, canUserWriteArtifact, canUserDeleteArtifact } from './artifactHelpers';
import type { BaseArtifact } from '../types/entities/ArtifactTypes';

/**
 * `permissions` has no schema default, so a stored artifact can lack it entirely. These helpers
 * are the ACCESS-CHECK path, so an unguarded dereference threw a TypeError where the answer should
 * simply be "no". Must stay in sync with the isPublic virtual in packages/database ArtifactModel.
 */

const withoutPermissions = {
  id: 'artifact_1',
  userId: 'owner-1',
  title: 'no permissions',
  visibility: 'private',
} as unknown as BaseArtifact;

const publicWithoutPermissions = { ...withoutPermissions, visibility: 'public' } as unknown as BaseArtifact;

const withPermissions = {
  ...withoutPermissions,
  permissions: { canRead: ['reader-1'], canWrite: ['writer-1'], canDelete: ['deleter-1'], isPublic: true },
} as unknown as BaseArtifact;

describe('artifact permission helpers on a row with no permissions sub-document', () => {
  it('reports it as not public instead of throwing', () => {
    expect(isPublicArtifact(withoutPermissions)).toBe(false);
  });

  it('still honours visibility: public', () => {
    expect(isPublicArtifact(publicWithoutPermissions)).toBe(true);
  });

  it('denies a non-owner rather than throwing', () => {
    expect(canUserReadArtifact(withoutPermissions, 'someone-else')).toBe(false);
    expect(canUserWriteArtifact(withoutPermissions, 'someone-else')).toBe(false);
    expect(canUserDeleteArtifact(withoutPermissions, 'someone-else')).toBe(false);
  });

  it('still admits the owner', () => {
    expect(canUserReadArtifact(withoutPermissions, 'owner-1')).toBe(true);
    expect(canUserWriteArtifact(withoutPermissions, 'owner-1')).toBe(true);
    expect(canUserDeleteArtifact(withoutPermissions, 'owner-1')).toBe(true);
  });
});

describe('artifact permission helpers when permissions are present', () => {
  it('reads each list off the sub-document', () => {
    expect(isPublicArtifact(withPermissions)).toBe(true);
    expect(canUserReadArtifact(withPermissions, 'reader-1')).toBe(true);
    expect(canUserWriteArtifact(withPermissions, 'writer-1')).toBe(true);
    expect(canUserDeleteArtifact(withPermissions, 'deleter-1')).toBe(true);
    expect(canUserWriteArtifact(withPermissions, 'reader-1')).toBe(false);
  });
});
