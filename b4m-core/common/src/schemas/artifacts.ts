import { z } from 'zod';
import { ArtifactTypeSchema } from '../types/entities/ArtifactTypes';

// Enums
export const ArtifactStatusSchema = z.enum(['draft', 'review', 'published', 'archived', 'deleted']);

export const VisibilitySchema = z.enum(['private', 'project', 'organization', 'public']);

// Permissions schema
export const ArtifactPermissionsSchema = z.object({
  canRead: z.array(z.string()),
  canWrite: z.array(z.string()),
  canDelete: z.array(z.string()),
  isPublic: z.boolean().prefault(false),
  inheritFromProject: z.boolean().prefault(true),
});

// Base artifact schema
export const BaseArtifactSchema = z.object({
  id: z.uuid(),
  type: ArtifactTypeSchema,
  title: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),

  // Versioning
  version: z.int().positive().prefault(1),
  versionTag: z.string().max(100).optional(),
  currentVersionId: z.uuid().optional(),
  parentVersionId: z.uuid().optional(),

  // Timestamps
  createdAt: z.date(),
  updatedAt: z.date(),
  publishedAt: z.date().optional(),
  deletedAt: z.date().optional(),

  // Ownership & Access
  userId: z.string(),
  projectId: z.string().optional(),
  organizationId: z.string().optional(),
  visibility: VisibilitySchema.prefault('private'),
  permissions: ArtifactPermissionsSchema,

  // Relationships
  sourceQuestId: z.string().optional(),
  sessionId: z.string().optional(),
  parentArtifactId: z.uuid().optional(),

  // Status
  status: ArtifactStatusSchema.prefault('draft'),
  tags: z.array(z.string().max(50)).max(20).prefault([]),

  // Content
  contentHash: z.string(),
  contentSize: z.int().nonnegative(),

  // Metadata
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Enhanced metadata schema for specific artifact types
export const EnhancedArtifactMetadataSchema = z.object({
  language: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

// Specific artifact schemas
export const ReactArtifactV2Schema = BaseArtifactSchema.extend({
  type: z.literal('react'),
  content: z.string(),
  metadata: EnhancedArtifactMetadataSchema.extend({
    dependencies: z.array(z.string()),
    props: z.record(z.string(), z.unknown()).optional(),
    hasDefaultExport: z.boolean(),
    errorBoundary: z.boolean().prefault(true),
  }),
});

export const HtmlArtifactV2Schema = BaseArtifactSchema.extend({
  type: z.literal('html'),
  content: z.string(),
  metadata: EnhancedArtifactMetadataSchema.extend({
    allowedScripts: z.array(z.string()).prefault([]),
    cspPolicy: z.string().optional(),
    sanitized: z.boolean().prefault(false),
  }),
});

export const SvgArtifactV2Schema = BaseArtifactSchema.extend({
  type: z.literal('svg'),
  content: z.string(),
  metadata: EnhancedArtifactMetadataSchema.extend({
    viewBox: z.string().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    sanitized: z.boolean().prefault(false),
  }),
});

export const MermaidArtifactV2Schema = BaseArtifactSchema.extend({
  type: z.literal('mermaid'),
  content: z.string(),
  metadata: EnhancedArtifactMetadataSchema.extend({
    chartType: z
      .enum([
        'flowchart',
        'sequenceDiagram',
        'classDiagram',
        'stateDiagram',
        'entityRelationshipDiagram',
        'gantt',
        'pie',
        'mindmap',
      ])
      .optional(),
    description: z.string().optional(),
  }),
});

export const PythonArtifactV2Schema = BaseArtifactSchema.extend({
  type: z.literal('python'),
  content: z.string(),
  metadata: EnhancedArtifactMetadataSchema.extend({
    packages: z.array(z.string()).default([]),
    hasOutput: z.boolean().default(false),
    executionState: z.enum(['idle', 'running', 'completed', 'error']).optional(),
    lastExecutionTime: z.number().optional(),
  }),
});

// Type exports
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export type ArtifactPermissions = z.infer<typeof ArtifactPermissionsSchema>;
export type BaseArtifact = z.infer<typeof BaseArtifactSchema>;
export type ReactArtifactV2 = z.infer<typeof ReactArtifactV2Schema>;
export type HtmlArtifactV2 = z.infer<typeof HtmlArtifactV2Schema>;
export type SvgArtifactV2 = z.infer<typeof SvgArtifactV2Schema>;
export type MermaidArtifactV2 = z.infer<typeof MermaidArtifactV2Schema>;
export type PythonArtifactV2 = z.infer<typeof PythonArtifactV2Schema>;

export enum ArtifactStatuses {
  DRAFT = 'draft',
  REVIEW = 'review',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
  DELETED = 'deleted',
}

// Validation helpers
export const validateBaseArtifact = (data: unknown): BaseArtifact => {
  return BaseArtifactSchema.parse(data);
};

export const validateReactArtifactV2 = (data: unknown): ReactArtifactV2 => {
  return ReactArtifactV2Schema.parse(data);
};

export const validateHtmlArtifactV2 = (data: unknown): HtmlArtifactV2 => {
  return HtmlArtifactV2Schema.parse(data);
};

export const validateSvgArtifactV2 = (data: unknown): SvgArtifactV2 => {
  return SvgArtifactV2Schema.parse(data);
};

export const validateMermaidArtifactV2 = (data: unknown): MermaidArtifactV2 => {
  return MermaidArtifactV2Schema.parse(data);
};

export const validatePythonArtifactV2 = (data: unknown): PythonArtifactV2 => {
  return PythonArtifactV2Schema.parse(data);
};
