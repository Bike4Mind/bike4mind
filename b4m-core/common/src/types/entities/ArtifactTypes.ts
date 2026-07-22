import { z } from 'zod';
import { QuestMasterArtifactV2 } from './QuestMasterArtifactTypes';
import {
  HtmlArtifactV2,
  MermaidArtifactV2,
  PythonArtifactV2,
  ReactArtifactV2,
  SvgArtifactV2,
} from '../../schemas/artifacts';
import { RechartsChartTypeSchema } from '../../schemas/llm';

// Base artifact metadata schema
export const ArtifactMetadataSchema = z.object({
  language: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

// Artifact type enum - Extended with Claude-style artifacts
export const ArtifactTypeSchema = z.enum([
  'mermaid',
  'recharts',
  'chess',
  'python',
  'react',
  'html',
  'svg',
  'code',
  'quest',
  'file',
  'questmaster',
  'lattice', // Financial pro-forma models
  'blog-draft', // Blog/social content drafts produced by the blog_draft tool
]);

export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

// Artifact type metadata info
export type ArtifactTypeInfo = {
  name: string;
  description: string;
  category: string;
  mimeType: string;
};

// Centralized registry of all artifact type metadata
// Adding a new artifact type = add entry here + add to ArtifactTypeSchema above
export const ARTIFACT_TYPE_REGISTRY = {
  mermaid: {
    name: 'Mermaid Diagram',
    description: 'Flowcharts, sequence diagrams, and other visual diagrams using Mermaid syntax',
    category: 'visualization',
    mimeType: 'text/plain',
  },
  recharts: {
    name: 'Chart/Graph',
    description: 'Interactive charts and graphs using Recharts library',
    category: 'visualization',
    mimeType: 'application/json',
  },
  python: {
    name: 'Python Script',
    description: 'Python code for data processing, analysis, and automation',
    category: 'code',
    mimeType: 'text/x-python',
  },
  react: {
    name: 'React Component',
    description: 'Interactive React components with JSX and hooks',
    category: 'interactive',
    mimeType: 'text/javascript',
  },
  html: {
    name: 'HTML Document',
    description: 'Static HTML pages with CSS styling',
    category: 'web',
    mimeType: 'text/html',
  },
  svg: {
    name: 'SVG Graphics',
    description: 'Scalable Vector Graphics for illustrations and icons',
    category: 'graphics',
    mimeType: 'image/svg+xml',
  },
  code: {
    name: 'Generic Code',
    description: 'General purpose code in various programming languages',
    category: 'code',
    mimeType: 'text/plain',
  },
  quest: {
    name: 'Quest/Tutorial',
    description: 'Learning quests and interactive tutorials',
    category: 'education',
    mimeType: 'application/json',
  },
  file: {
    name: 'File Artifact',
    description: 'Generic file artifacts for documents and media',
    category: 'document',
    mimeType: 'application/octet-stream',
  },
  questmaster: {
    name: 'QuestMaster Plan',
    description: 'Complex multi-step learning plans with dependencies',
    category: 'education',
    mimeType: 'application/json',
  },
  lattice: {
    name: 'Financial Model',
    description: 'Financial pro-forma models and projections',
    category: 'finance',
    mimeType: 'application/json',
  },
  chess: {
    name: 'Chess Game',
    description: 'Interactive chess board with move validation and AI opponent',
    category: 'interactive',
    mimeType: 'application/json',
  },
  'blog-draft': {
    name: 'Blog Draft',
    description: 'Drafted blog/social content ready for review and publishing',
    category: 'document',
    mimeType: 'application/json',
  },
} as const satisfies Record<ArtifactType, ArtifactTypeInfo>;

// Derive unique categories from the registry
export const ARTIFACT_CATEGORIES = [
  ...new Set(Object.values(ARTIFACT_TYPE_REGISTRY).map(info => info.category)),
] as const;

// Helper to get MIME type for an artifact type
export function getArtifactMimeType(type: ArtifactType): string {
  return ARTIFACT_TYPE_REGISTRY[type].mimeType;
}

// Helper to get full type info
export function getArtifactTypeInfo(type: ArtifactType): ArtifactTypeInfo {
  return ARTIFACT_TYPE_REGISTRY[type];
}

// Re-export from schemas for consistency
export type {
  ArtifactPermissions,
  ArtifactStatus,
  BaseArtifact,
  ReactArtifactV2,
  HtmlArtifactV2,
  SvgArtifactV2,
  MermaidArtifactV2,
  PythonArtifactV2,
} from '../../schemas/artifacts';

// Base artifact schema (keeping for backward compatibility)
export const ArtifactSchema = z.object({
  id: z.string(),
  type: ArtifactTypeSchema,
  title: z.string(),
  content: z.string(),
  preview: z.string().optional(),
  metadata: ArtifactMetadataSchema.optional(),
  version: z.int().positive().prefault(1).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

// Quest-specific artifact (keeping for backward compatibility)
export const QuestMasterArtifactSchema = ArtifactSchema.extend({
  type: z.literal('quest'),
  metadata: ArtifactMetadataSchema.extend({
    complexity: z.string(),
    status: z.string(),
    subQuests: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
      })
    ),
  }),
});

export type QuestMasterArtifact = z.infer<typeof QuestMasterArtifactSchema>;

// React-specific artifact (keeping for backward compatibility)
export const ReactArtifactSchema = ArtifactSchema.extend({
  type: z.literal('react'),
  metadata: ArtifactMetadataSchema.extend({
    dependencies: z.array(z.string()).prefault([]),
    props: z.record(z.string(), z.unknown()).optional(),
    hasDefaultExport: z.boolean().prefault(true),
    errorBoundary: z.boolean().prefault(true),
  }),
});

export type ReactArtifact = z.infer<typeof ReactArtifactSchema>;

// HTML-specific artifact (keeping for backward compatibility)
export const HtmlArtifactSchema = ArtifactSchema.extend({
  type: z.literal('html'),
  metadata: ArtifactMetadataSchema.extend({
    allowedScripts: z.array(z.string()).prefault([]),
    cspPolicy: z.string().optional(),
    sanitized: z.boolean().prefault(true),
  }),
});

export type HtmlArtifact = z.infer<typeof HtmlArtifactSchema>;

// SVG-specific artifact (keeping for backward compatibility)
export const SvgArtifactSchema = ArtifactSchema.extend({
  type: z.literal('svg'),
  metadata: ArtifactMetadataSchema.extend({
    viewBox: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    sanitized: z.boolean().prefault(true),
  }),
});

export type SvgArtifact = z.infer<typeof SvgArtifactSchema>;

// Mermaid-specific artifact (keeping for backward compatibility)
export const MermaidArtifactSchema = ArtifactSchema.extend({
  type: z.literal('mermaid'),
  metadata: ArtifactMetadataSchema.extend({
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

export type MermaidArtifact = z.infer<typeof MermaidArtifactSchema>;

// Recharts-specific artifact
export const RechartsArtifactSchema = ArtifactSchema.extend({
  type: z.literal('recharts'),
  metadata: ArtifactMetadataSchema.extend({
    chartType: RechartsChartTypeSchema.optional(),
    description: z.string().optional(),
    dataPoints: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    xAxis: z.string().optional(),
    yAxis: z.string().optional(),
    colors: z.array(z.string()).optional(),
  }),
});

export type RechartsArtifact = z.infer<typeof RechartsArtifactSchema>;

// Chess-specific artifact
export const ChessArtifactSchema = ArtifactSchema.extend({
  type: z.literal('chess'),
  metadata: ArtifactMetadataSchema.extend({
    fen: z.string().optional(),
    turn: z.enum(['w', 'b']).optional(),
    lastMove: z
      .object({
        from: z.string(),
        to: z.string(),
        san: z.string().optional(),
      })
      .optional(),
    isCheck: z.boolean().optional(),
    isCheckmate: z.boolean().optional(),
    isDraw: z.boolean().optional(),
    isGameOver: z.boolean().optional(),
    moveNumber: z.number().optional(),
  }),
});

export type ChessArtifact = z.infer<typeof ChessArtifactSchema>;

// Lattice-specific artifact (financial pro-forma models)
export const LatticeArtifactSchema = ArtifactSchema.extend({
  type: z.literal('lattice'),
  metadata: ArtifactMetadataSchema.extend({
    modelType: z.enum(['income_statement', 'balance_sheet', 'cashflow', 'saas_metrics', 'custom']).optional(),
    periodGrain: z.enum(['month', 'quarter', 'year']).optional(),
    currency: z.string().prefault('USD'),
    entityCount: z.int().nonnegative().optional(),
    ruleCount: z.int().nonnegative().optional(),
    lastComputedAt: z.date().optional(),
  }),
});

export type LatticeArtifact = z.infer<typeof LatticeArtifactSchema>;

// Python-specific artifact
export const PythonArtifactSchema = ArtifactSchema.extend({
  type: z.literal('python'),
  metadata: ArtifactMetadataSchema.extend({
    packages: z.array(z.string()).default([]),
    hasOutput: z.boolean().default(false),
    executionState: z.enum(['idle', 'running', 'completed', 'error']).optional(),
    lastExecutionTime: z.number().optional(),
  }),
});

export type PythonArtifact = z.infer<typeof PythonArtifactSchema>;

// Mermaid chart metadata schema
export const MermaidChartMetadataSchema = z.object({
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
});

export type MermaidChartMetadata = z.infer<typeof MermaidChartMetadataSchema>;

// Enhanced chat history item with artifacts
export const ChatHistoryItemWithArtifactsSchema = z.object({
  artifacts: z.array(ArtifactSchema).optional(),
});

export type ChatHistoryItemWithArtifacts = z.infer<typeof ChatHistoryItemWithArtifactsSchema>;

// Artifact operation types
export const ArtifactOperationSchema = z.enum(['create', 'update', 'rewrite']);
export type ArtifactOperation = z.infer<typeof ArtifactOperationSchema>;

// Artifact create/update payload
export const ArtifactPayloadSchema = z.object({
  operation: ArtifactOperationSchema,
  artifactId: z.string().optional(), // Required for update/rewrite
  type: ArtifactTypeSchema,
  title: z.string(),
  content: z.string(),
  metadata: ArtifactMetadataSchema.optional(),
});

export type ArtifactPayload = z.infer<typeof ArtifactPayloadSchema>;

/**
 * Regex sub-pattern (as a string) that matches the attribute portion of an
 * `<artifact ...>` opening tag. It handles:
 *  - newlines inside the attribute list (AI sometimes wraps long tags),
 *  - `>` characters inside double- or single-quoted attribute values.
 *
 * Exported as a string (not a compiled RegExp) so each consumer can
 * compose it into their own regex with the flags they need, avoiding
 * shared mutable `lastIndex` state.
 *
 * Usage: `new RegExp('<artifact\\s+(' + ARTIFACT_ATTRS_PATTERN + ')>...')`
 */
export const ARTIFACT_ATTRS_PATTERN = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;

// Claude-style artifact MIME types
export const ClaudeArtifactMimeTypes = {
  REACT: 'application/vnd.ant.react',
  HTML: 'text/html',
  SVG: 'image/svg+xml',
  MERMAID: 'application/vnd.ant.mermaid',
  RECHARTS: 'application/vnd.ant.recharts',
  CHESS: 'application/vnd.ant.chess',
  CODE: 'application/vnd.ant.code',
  MARKDOWN: 'text/markdown',
  LATTICE: 'application/vnd.b4m.lattice',
  PYTHON: 'application/vnd.ant.python',
  BLOG_DRAFT: 'application/vnd.b4m.blog-draft',
} as const;

/**
 * Map a MIME type (or AI-provider artifact-type string) to an internal {@link ArtifactType}.
 *
 * Single source of truth - consumed by the artifact parsers (b4m-core/utils + client) and the
 * tool_result dedup in ChatCompletionProcess. Exact blessed-type matches first (case-insensitive,
 * since MIME types are), then language/format inference; returns null if unrecognized.
 *
 * This previously lived as three hand-maintained copies that drifted - e.g. the lattice
 * tool emits `application/vnd.b4m.lattice` but a copy matched `application/vnd.ant.lattice`,
 * letting lattice tool_result artifacts dodge the dedup set.
 */
export function mapMimeTypeToArtifactType(mimeType: string | null | undefined): ArtifactType | null {
  // Several call sites pass cast untyped metadata (e.g. `metadata.artifactType as string`), which
  // can be undefined at runtime - guard so we return null instead of throwing on `.toLowerCase()`.
  if (!mimeType) return null;
  const normalized = mimeType.toLowerCase().trim();

  switch (normalized) {
    case ClaudeArtifactMimeTypes.REACT.toLowerCase():
      return 'react';
    case ClaudeArtifactMimeTypes.HTML.toLowerCase():
      return 'html';
    case ClaudeArtifactMimeTypes.SVG.toLowerCase():
      return 'svg';
    case ClaudeArtifactMimeTypes.MERMAID.toLowerCase():
      return 'mermaid';
    case ClaudeArtifactMimeTypes.RECHARTS.toLowerCase():
      return 'recharts';
    case ClaudeArtifactMimeTypes.CHESS.toLowerCase():
      return 'chess';
    case ClaudeArtifactMimeTypes.CODE.toLowerCase():
      return 'code';
    case ClaudeArtifactMimeTypes.MARKDOWN.toLowerCase():
      return 'code'; // markdown is rendered through the code viewer
    case ClaudeArtifactMimeTypes.LATTICE.toLowerCase():
      return 'lattice';
    case ClaudeArtifactMimeTypes.PYTHON.toLowerCase():
      return 'python';
    case ClaudeArtifactMimeTypes.BLOG_DRAFT.toLowerCase():
      return 'blog-draft';
  }

  // Inference fallback for standard MIME types / provider language formats.
  if (normalized.includes('jsx') || normalized.includes('react')) return 'react';
  if (normalized.includes('javascript') || normalized.includes('typescript')) return 'code';
  if (normalized.includes('python') || normalized === 'text/x-python') return 'python';
  if (
    normalized.includes('java') ||
    normalized.includes('c++') ||
    normalized.includes('rust') ||
    normalized.includes('go') ||
    normalized.includes('ruby') ||
    normalized.includes('php') ||
    normalized.includes('swift') ||
    normalized.includes('kotlin') ||
    normalized.includes('csharp') ||
    normalized.includes('c#')
  ) {
    return 'code';
  }
  if (normalized.includes('html') || normalized.includes('xhtml')) return 'html';
  if (normalized.includes('svg')) return 'svg';
  if (normalized.includes('markdown') || normalized.includes('md')) return 'code';
  if (normalized.includes('mermaid')) return 'mermaid';
  if (normalized.includes('recharts') || normalized.includes('chart')) return 'recharts';
  if (normalized.includes('chess')) return 'chess';

  return null;
}

// Utility type for artifact preview components
export interface ArtifactPreviewProps<T extends Artifact = Artifact> {
  artifact: T;
  onClick?: () => void;
  className?: string;
}

// Utility type for full artifact viewer components
export interface ArtifactViewerProps<T extends Artifact = Artifact> {
  artifact: T;
  onClose?: () => void;
  onEdit?: (updatedArtifact: T) => void;
  className?: string;
}

// Type union for all specific artifact types (keeping for backward compatibility)
export type SpecificArtifact =
  | ReactArtifact
  | HtmlArtifact
  | SvgArtifact
  | MermaidArtifact
  | RechartsArtifact
  | ChessArtifact
  | QuestMasterArtifact
  | LatticeArtifact
  | PythonArtifact;

// New: Type union for all V2 specific artifacts
export type SpecificArtifactV2 =
  ReactArtifactV2 | HtmlArtifactV2 | SvgArtifactV2 | MermaidArtifactV2 | PythonArtifactV2 | QuestMasterArtifactV2;
