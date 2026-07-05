import { describe, it, expect } from 'vitest';
import {
  BaseArtifactSchema,
  ReactArtifactV2Schema,
  ArtifactStatusSchema,
  VisibilitySchema,
} from '../schemas/artifacts';
import { QuestMasterArtifactV2Schema as QuestMasterSchema } from '../schemas/questmaster';

describe('Artifact Schemas', () => {
  describe('BaseArtifactSchema', () => {
    it('should validate a complete artifact', () => {
      const artifact = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'react',
        title: 'Test Component',
        version: 1,
        status: 'published',
        userId: 'user-123',
        visibility: 'private',
        permissions: {
          canRead: ['user-123'],
          canWrite: ['user-123'],
          canDelete: ['user-123'],
          isPublic: false,
          inheritFromProject: true,
        },
        tags: ['test', 'component'],
        contentHash: 'abc123',
        contentSize: 1024,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = BaseArtifactSchema.safeParse(artifact);
      expect(result.success).toBe(true);
    });

    it('should provide defaults for optional fields', () => {
      const minimal = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'react',
        title: 'Test',
        userId: 'user-123',
        permissions: {
          canRead: [],
          canWrite: [],
          canDelete: [],
        },
        contentHash: 'abc123',
        contentSize: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = BaseArtifactSchema.parse(minimal);
      expect(result.version).toBe(1);
      expect(result.status).toBe('draft');
      expect(result.visibility).toBe('private');
      expect(result.tags).toEqual([]);
      expect(result.permissions.isPublic).toBe(false);
      expect(result.permissions.inheritFromProject).toBe(true);
    });

    it('should reject invalid UUIDs', () => {
      const invalid = {
        id: 'not-a-uuid',
        type: 'react',
        title: 'Test',
        userId: 'user-123',
        permissions: {
          canRead: [],
          canWrite: [],
          canDelete: [],
        },
        contentHash: 'abc123',
        contentSize: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = BaseArtifactSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should enforce title constraints', () => {
      const base = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'react',
        userId: 'user-123',
        permissions: {
          canRead: [],
          canWrite: [],
          canDelete: [],
        },
        contentHash: 'abc123',
        contentSize: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Empty title
      const emptyTitle = { ...base, title: '' };
      expect(BaseArtifactSchema.safeParse(emptyTitle).success).toBe(false);

      // Title too long
      const longTitle = { ...base, title: 'a'.repeat(256) };
      expect(BaseArtifactSchema.safeParse(longTitle).success).toBe(false);

      // Valid title
      const validTitle = { ...base, title: 'Valid Title' };
      expect(BaseArtifactSchema.safeParse(validTitle).success).toBe(true);
    });

    it('should enforce tag constraints', () => {
      const base = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'react',
        title: 'Test',
        userId: 'user-123',
        permissions: {
          canRead: [],
          canWrite: [],
          canDelete: [],
        },
        contentHash: 'abc123',
        contentSize: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Too many tags
      const tooManyTags = { ...base, tags: Array(21).fill('tag') };
      expect(BaseArtifactSchema.safeParse(tooManyTags).success).toBe(false);

      // Tag too long
      const longTag = { ...base, tags: ['a'.repeat(51)] };
      expect(BaseArtifactSchema.safeParse(longTag).success).toBe(false);

      // Valid tags
      const validTags = { ...base, tags: ['tag1', 'tag2', 'tag3'] };
      expect(BaseArtifactSchema.safeParse(validTags).success).toBe(true);
    });
  });

  describe('ReactArtifactV2Schema', () => {
    it('should validate React artifact with metadata', () => {
      const reactArtifact = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'react',
        title: 'Button Component',
        content: 'export default function Button() { return <button>Click me</button>; }',
        metadata: {
          dependencies: ['react'],
          hasDefaultExport: true,
          errorBoundary: true,
        },
        version: 1,
        status: 'published',
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
        contentHash: 'xyz789',
        contentSize: 2048,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = ReactArtifactV2Schema.safeParse(reactArtifact);
      expect(result.success).toBe(true);
    });

    it('should enforce type literal', () => {
      const wrongType = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'html', // Wrong type
        content: 'function Component() {}',
        metadata: {
          dependencies: [],
          hasDefaultExport: true,
        },
        userId: 'user-123',
        permissions: {
          canRead: [],
          canWrite: [],
          canDelete: [],
        },
        contentHash: 'abc123',
        contentSize: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = ReactArtifactV2Schema.safeParse(wrongType);
      expect(result.success).toBe(false);
    });

    it('should require React-specific metadata fields', () => {
      const missingMetadata = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'react',
        title: 'Component',
        content: 'export default function Component() {}',
        metadata: {
          dependencies: ['react'],
          // Missing hasDefaultExport
        },
        userId: 'user-123',
        permissions: {
          canRead: [],
          canWrite: [],
          canDelete: [],
        },
        contentHash: 'abc123',
        contentSize: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = ReactArtifactV2Schema.safeParse(missingMetadata);
      expect(result.success).toBe(false);
    });
  });

  describe('QuestMasterArtifactV2Schema', () => {
    it('should validate QuestMaster artifact', () => {
      const questArtifact = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'questmaster',
        title: 'Learn React',
        content: {
          goal: 'Master React development',
          quests: [
            {
              id: '550e8400-e29b-41d4-a716-446655440001',
              title: 'Setup Environment',
              description: 'Install Node.js and create React app',
              status: 'completed',
              order: 0,
            },
            {
              id: '550e8400-e29b-41d4-a716-446655440002',
              title: 'Learn Components',
              description: 'Understand React components',
              status: 'in-progress',
              order: 1,
              dependencies: ['550e8400-e29b-41d4-a716-446655440001'],
            },
          ],
          totalSteps: 2,
          complexity: 'medium',
        },
        version: 1,
        status: 'published',
        userId: 'user-123',
        visibility: 'private',
        permissions: {
          canRead: ['user-123'],
          canWrite: ['user-123'],
          canDelete: ['user-123'],
          isPublic: false,
          inheritFromProject: true,
        },
        tags: ['react', 'tutorial'],
        contentHash: 'quest123',
        contentSize: 4096,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = QuestMasterSchema.safeParse(questArtifact);
      expect(result.success).toBe(true);
    });

    it('should require at least one quest', () => {
      const noQuests = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'questmaster',
        title: 'Empty Quest',
        content: {
          goal: 'No quests',
          quests: [], // Empty array
          totalSteps: 0,
          complexity: 'low',
        },
        userId: 'user-123',
        permissions: {
          canRead: [],
          canWrite: [],
          canDelete: [],
        },
        contentHash: 'abc123',
        contentSize: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = QuestMasterSchema.safeParse(noQuests);
      expect(result.success).toBe(false);
    });
  });

  describe('Enum Schemas', () => {
    it('should validate artifact status', () => {
      expect(ArtifactStatusSchema.safeParse('draft').success).toBe(true);
      expect(ArtifactStatusSchema.safeParse('review').success).toBe(true);
      expect(ArtifactStatusSchema.safeParse('published').success).toBe(true);
      expect(ArtifactStatusSchema.safeParse('archived').success).toBe(true);
      expect(ArtifactStatusSchema.safeParse('deleted').success).toBe(true);
      expect(ArtifactStatusSchema.safeParse('invalid').success).toBe(false);
    });

    it('should validate visibility', () => {
      expect(VisibilitySchema.safeParse('private').success).toBe(true);
      expect(VisibilitySchema.safeParse('project').success).toBe(true);
      expect(VisibilitySchema.safeParse('organization').success).toBe(true);
      expect(VisibilitySchema.safeParse('public').success).toBe(true);
      expect(VisibilitySchema.safeParse('invalid').success).toBe(false);
    });
  });
});
