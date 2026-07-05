import { z } from 'zod';

/**
 * Curation Type Enum
 *
 * Defines the two curation modes:
 * - TRANSCRIPT: Template-based chronological transcript (Option 1)
 * - EXECUTIVE_SUMMARY: AI-powered executive summary (Option 2)
 */
export enum CurationType {
  /** Template-based raw transcript for HR/legal/compliance */
  TRANSCRIPT = 'transcript',
  /** AI-powered executive summary for knowledge sharing */
  EXECUTIVE_SUMMARY = 'executive_summary',
}

/**
 * Curation Type Schema for validation
 */
export const CurationTypeSchema = z.enum(CurationType);

/**
 * Curation Artifact Type Enum
 *
 * Defines all extractable artifact types from notebook conversations
 * Note: Enum values are lowercase to match internal service layer
 * Named CurationArtifactType to avoid conflict with existing ArtifactType in ./types
 */
export enum CurationArtifactType {
  CODE = 'code',
  REACT = 'react',
  HTML = 'html',
  MERMAID = 'mermaid',
  RECHARTS = 'recharts',
  SVG = 'svg',
  QUESTMASTER_PLAN = 'questmaster_plan',
  DEEP_RESEARCH = 'deep_research',
  IMAGE = 'image',
}

/**
 * Curation Artifact Type Schema for validation
 * Maps API uppercase strings to internal lowercase enum values
 */
export const CurationArtifactTypeSchema = z.enum([
  'CODE',
  'REACT',
  'HTML',
  'MERMAID',
  'RECHARTS',
  'SVG',
  'QUESTMASTER_PLAN',
  'DEEP_RESEARCH',
  'IMAGE',
]);

/**
 * Inferred type from CurationArtifactTypeSchema (API format with uppercase)
 */
export type CurationArtifactTypeAPI = z.infer<typeof CurationArtifactTypeSchema>;

/**
 * Export Format Schema
 *
 * Supported output formats for curated notebooks
 */
export const ExportFormatSchema = z.enum(['markdown', 'txt', 'html']);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

/**
 * Curation Options Schema
 *
 * Configuration options for notebook curation
 */
export const CurationOptionsSchema = z.object({
  /** Curation type: transcript (Option 1) or executive_summary (Option 2) */
  curationType: CurationTypeSchema.prefault(CurationType.TRANSCRIPT),
  /** Include code artifacts in the curated notebook */
  includeCode: z.boolean().prefault(true),
  /** Include diagrams (Mermaid, SVG) in the curated notebook */
  includeDiagrams: z.boolean().prefault(true),
  /** Include data visualizations (Recharts) in the curated notebook */
  includeDataViz: z.boolean().prefault(true),
  /** Include QuestMaster plans in the curated notebook */
  includeQuestMaster: z.boolean().prefault(true),
  /** Include Deep Research findings in the curated notebook */
  includeResearch: z.boolean().prefault(true),
  /** Include images in the curated notebook */
  includeImages: z.boolean().prefault(true),
  /** Token budget for processing (varies by curation type) */
  tokenBudget: z.number().optional(),
  /** Export format for the curated notebook */
  exportFormat: ExportFormatSchema.prefault('markdown'),
  /** Custom notebook name (optional, defaults to curated-notebook-{sessionId}) */
  customNotebookName: z.string().optional(),
});

export type CurationOptions = z.infer<typeof CurationOptionsSchema>;
