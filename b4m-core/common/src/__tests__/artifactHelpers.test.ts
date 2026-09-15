import { describe, it, expect } from 'vitest';
import {
  isArtifact,
  isPublicArtifact,
  canUserReadArtifact,
  calculateContentHash,
  validateArtifactTitle,
  canTransitionStatus,
  sortArtifacts,
  createDefaultPermissions,
} from '../utils/artifactHelpers';
import { BaseArtifact } from '../types/entities/ArtifactTypes';
import { ArtifactStatuses } from '../schemas/artifacts';

describe('Artifact Helpers', () => {
  const mockArtifact: BaseArtifact = {
    id: 'test-123',
    type: 'react',
    title: 'Test Artifact',
    version: 1,
    status: ArtifactStatuses.PUBLISHED,
    userId: 'user-123',
    visibility: 'private',
    permissions: {
      canRead: ['user-123'],
      canWrite: ['user-123'],
      canDelete: ['user-123'],
      isPublic: false,
      inheritFromProject: true,
    },
    tags: [],
    contentHash: 'abc123',
    contentSize: 1024,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
    metadata: {},
  };

  describe('isArtifact', () => {
    it('should return true for valid artifact', () => {
      expect(isArtifact(mockArtifact)).toBe(true);
    });

    it('should return false for invalid objects', () => {
      expect(isArtifact(null)).toBe(false);
      expect(isArtifact({})).toBe(false);
      expect(isArtifact({ id: '123' })).toBe(false);
      expect(isArtifact({ id: '123', type: 'react' })).toBe(false);
    });
  });

  describe('isPublicArtifact', () => {
    it('should return true for public visibility', () => {
      const publicArtifact = { ...mockArtifact, visibility: 'public' as const };
      expect(isPublicArtifact(publicArtifact)).toBe(true);
    });

    it('should return true for public permission', () => {
      const publicArtifact = {
        ...mockArtifact,
        permissions: { ...mockArtifact.permissions, isPublic: true },
      };
      expect(isPublicArtifact(publicArtifact)).toBe(true);
    });

    it('should return false for private artifact', () => {
      expect(isPublicArtifact(mockArtifact)).toBe(false);
    });
  });

  describe('canUserReadArtifact', () => {
    it('should allow owner to read', () => {
      expect(canUserReadArtifact(mockArtifact, 'user-123')).toBe(true);
    });

    it('should allow users in read permissions', () => {
      const artifact = {
        ...mockArtifact,
        permissions: {
          ...mockArtifact.permissions,
          canRead: ['user-123', 'user-456'],
        },
      };
      expect(canUserReadArtifact(artifact, 'user-456')).toBe(true);
    });

    it('should deny users not in permissions', () => {
      expect(canUserReadArtifact(mockArtifact, 'user-999')).toBe(false);
    });

    it('should allow anyone to read public artifacts', () => {
      const publicArtifact = { ...mockArtifact, visibility: 'public' as const };
      expect(canUserReadArtifact(publicArtifact, 'user-999')).toBe(true);
    });
  });

  describe('calculateContentHash', () => {
    it('should generate consistent hash for same content', () => {
      const content = 'Hello, World!';
      const hash1 = calculateContentHash(content);
      const hash2 = calculateContentHash(content);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 produces 64 character hex string
    });

    it('should generate different hash for different content', () => {
      const hash1 = calculateContentHash('Hello');
      const hash2 = calculateContentHash('World');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('validateArtifactTitle', () => {
    it('should accept valid titles', () => {
      expect(validateArtifactTitle('Valid Title')).toEqual({ valid: true });
      expect(validateArtifactTitle('A')).toEqual({ valid: true });
      expect(validateArtifactTitle('Title with numbers 123')).toEqual({ valid: true });
    });

    it('should reject empty titles', () => {
      expect(validateArtifactTitle('')).toEqual({
        valid: false,
        error: 'Title is required',
      });
      expect(validateArtifactTitle('   ')).toEqual({
        valid: false,
        error: 'Title is required',
      });
    });

    it('should reject titles over 255 characters', () => {
      const longTitle = 'a'.repeat(256);
      expect(validateArtifactTitle(longTitle)).toEqual({
        valid: false,
        error: 'Title must be 255 characters or less',
      });
    });
  });

  describe('canTransitionStatus', () => {
    it('should allow valid transitions from DRAFT', () => {
      expect(canTransitionStatus(ArtifactStatuses.DRAFT, ArtifactStatuses.REVIEW)).toBe(true);
      expect(canTransitionStatus(ArtifactStatuses.DRAFT, ArtifactStatuses.PUBLISHED)).toBe(true);
      expect(canTransitionStatus(ArtifactStatuses.DRAFT, ArtifactStatuses.DELETED)).toBe(true);
    });

    it('should disallow invalid transitions from DRAFT', () => {
      expect(canTransitionStatus(ArtifactStatuses.DRAFT, ArtifactStatuses.ARCHIVED)).toBe(false);
    });

    it('should disallow any transitions from DELETED', () => {
      expect(canTransitionStatus(ArtifactStatuses.DELETED, ArtifactStatuses.DRAFT)).toBe(false);
      expect(canTransitionStatus(ArtifactStatuses.DELETED, ArtifactStatuses.PUBLISHED)).toBe(false);
    });

    it('should allow PUBLISHED to ARCHIVED transition', () => {
      expect(canTransitionStatus(ArtifactStatuses.PUBLISHED, ArtifactStatuses.ARCHIVED)).toBe(true);
    });
  });

  describe('sortArtifacts', () => {
    const artifacts: BaseArtifact[] = [
      { ...mockArtifact, id: '1', title: 'B Artifact', updatedAt: new Date('2024-01-02') },
      { ...mockArtifact, id: '2', title: 'A Artifact', updatedAt: new Date('2024-01-03') },
      { ...mockArtifact, id: '3', title: 'C Artifact', updatedAt: new Date('2024-01-01') },
    ];

    it('should sort by updatedAt descending by default', () => {
      const sorted = sortArtifacts(artifacts);
      expect(sorted[0].id).toBe('2'); // Most recent
      expect(sorted[1].id).toBe('1');
      expect(sorted[2].id).toBe('3'); // Oldest
    });

    it('should sort by title ascending', () => {
      const sorted = sortArtifacts(artifacts, 'title', 'asc');
      expect(sorted[0].title).toBe('A Artifact');
      expect(sorted[1].title).toBe('B Artifact');
      expect(sorted[2].title).toBe('C Artifact');
    });

    it('should sort by title descending', () => {
      const sorted = sortArtifacts(artifacts, 'title', 'desc');
      expect(sorted[0].title).toBe('C Artifact');
      expect(sorted[1].title).toBe('B Artifact');
      expect(sorted[2].title).toBe('A Artifact');
    });

    it('should not mutate original array', () => {
      const original = [...artifacts];
      sortArtifacts(artifacts);
      expect(artifacts).toEqual(original);
    });
  });

  describe('createDefaultPermissions', () => {
    it('should create permissions with user as owner', () => {
      const permissions = createDefaultPermissions('user-123');
      expect(permissions).toEqual({
        canRead: ['user-123'],
        canWrite: ['user-123'],
        canDelete: ['user-123'],
        isPublic: false,
        inheritFromProject: true,
      });
    });
  });
});
