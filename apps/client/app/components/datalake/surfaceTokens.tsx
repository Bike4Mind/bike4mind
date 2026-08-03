/**
 * surfaceTokens - the injection seam that keeps the standalone Data Lake surface
 * (`/data-lakes`, rendered by `DataLakeExplorer`) brand-agnostic.
 *
 * Theme (hues), copy (labels, empty state, chat prompts), icons, and the tag
 * taxonomy labels all live here with NEUTRAL defaults. A branded surface wraps the
 * explorer in `DataLakeSurfaceProvider` and overrides only what it needs, so no
 * product-specific string, hue, or glyph ever has to be edited into the shared
 * components. Anything added to the shared components that reads as product flavor
 * belongs in this file as a token instead.
 */

import ArticleIcon from '@mui/icons-material/Article';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import SummarizeOutlinedIcon from '@mui/icons-material/SummarizeOutlined';
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import { SURFACE_HUES, type Hue } from '@client/app/components/datalake/surfaceChrome';
import { DATA_LAKE, DATA_LAKES } from '@client/app/components/datalake/dataLakeBranding';

/** Any MUI icon component - only `sx` is passed by the surface. */
type SurfaceIcon = ComponentType<{ sx?: Record<string, unknown> }>;

export interface DataLakeSurfaceTheme {
  /** Lead ink: selection, header rule, empty-state emitter, hover glow. */
  accent: Hue;
  /** Gradient partner for the accent and hover ink for the secondary action. */
  secondary: Hue;
  /** Ink for a branch whose top-level prefix has no entry in `branchHues`. */
  branchDefault: Hue;
  /** Top-level tag prefix -> ink, so depth reads at a glance. */
  branchHues: Record<string, Hue>;
}

export interface DataLakeSurfaceCopy {
  /** Trailing breadcrumb crumb for the explorer itself. */
  explorerTitle: string;
  /** Leading breadcrumb crumb, wired to the explorer's `onBack`. */
  rootLabel: string;
  dropTitle: string;
  dropHint: string;
  /** Resting affordance, shown while no drag is underway so the capability is discoverable. */
  dropRestingHint: string;
  /** Verb phrase completing the post-drop success toast ("3 files ready to add..."). */
  dropAcceptedHint: string;
  emptyTitle: string;
  emptyHint: string;
  /** Zero-state variants, shown instead of `empty*` when the create-first CTA is offered. */
  zeroTitle: string;
  zeroHint: string;
  createLabel: string;
  askAboutLabel: string;
  askAboutPrompt: (title: string) => string;
  /** Optional second action under an article; omit to render only "ask about". */
  secondaryActionLabel?: string;
  secondaryActionPrompt?: (title: string) => string;
  statArticlesLabel: string;
  statBranchesLabel: string;
  statDepthLabel: string;
  /** Shown as the depth stat's sub-value while at the root of the tree. */
  depthRootLabel: string;
  /** Back-crumb label shown when stepping out of a first-level branch. */
  allCategoriesLabel: string;
}

export interface DataLakeSurfaceIcons {
  /** A single document in the tree's leaf list. */
  article: SurfaceIcon;
  /** A branch with children. */
  branch: SurfaceIcon;
  /** A branch whose children are documents. */
  leafBranch: SurfaceIcon;
  /** Decorator for the article's secondary action button. */
  secondaryAction: SurfaceIcon;
}

/** Human labels for raw tag segments, keyed by segment. Depth 0 = prefix, depth 1 = category. */
export interface DataLakeSurfaceTaxonomy {
  prefixLabels: Record<string, string>;
  categoryLabels: Record<string, string>;
}

export interface DataLakeSurfaceTokens {
  theme: DataLakeSurfaceTheme;
  copy: DataLakeSurfaceCopy;
  icons: DataLakeSurfaceIcons;
  taxonomy: DataLakeSurfaceTaxonomy;
}

export interface DataLakeSurfaceOverrides {
  theme?: Partial<DataLakeSurfaceTheme>;
  copy?: Partial<DataLakeSurfaceCopy>;
  icons?: Partial<DataLakeSurfaceIcons>;
  taxonomy?: Partial<DataLakeSurfaceTaxonomy>;
}

export const DEFAULT_DATA_LAKE_SURFACE_TOKENS: DataLakeSurfaceTokens = {
  theme: {
    accent: SURFACE_HUES.blue,
    secondary: SURFACE_HUES.violet,
    branchDefault: SURFACE_HUES.slate,
    branchHues: {},
  },
  copy: {
    explorerTitle: `${DATA_LAKE} Explorer`,
    rootLabel: DATA_LAKES,
    dropTitle: `Drop to add to a ${DATA_LAKE.toLowerCase()}`,
    dropHint: "Files or folders - you'll pick the destination next",
    dropRestingHint: 'Drag files here to add',
    dropAcceptedHint: `ready to add to a ${DATA_LAKE.toLowerCase()}`,
    emptyTitle: 'Nothing selected yet',
    emptyHint: 'Pick a branch from the tree, or jump into one of the largest categories below.',
    zeroTitle: 'Nothing here yet',
    zeroHint: `Create your first ${DATA_LAKE.toLowerCase()} to turn your files into searchable knowledge.`,
    createLabel: `Create ${DATA_LAKE.toLowerCase()}`,
    askAboutLabel: 'Ask about this document',
    askAboutPrompt: title => `Tell me about this document: ${title}`,
    secondaryActionLabel: 'Summarize the key points',
    secondaryActionPrompt: title => `Summarize the key points of "${title}" in a few short bullets.`,
    statArticlesLabel: 'Documents',
    statBranchesLabel: 'Branches',
    statDepthLabel: 'Depth',
    depthRootLabel: 'top',
    allCategoriesLabel: 'All Categories',
  },
  icons: {
    article: ArticleIcon,
    branch: FolderIcon,
    leafBranch: FolderOpenIcon,
    secondaryAction: SummarizeOutlinedIcon,
  },
  taxonomy: {
    prefixLabels: {},
    categoryLabels: {},
  },
};

const DataLakeSurfaceContext = createContext<DataLakeSurfaceTokens>(DEFAULT_DATA_LAKE_SURFACE_TOKENS);

/**
 * Overrides are merged one level deep (per section), so a caller can replace a
 * single string or hue without restating the rest of the section.
 */
export function DataLakeSurfaceProvider({
  tokens,
  children,
}: {
  tokens: DataLakeSurfaceOverrides;
  children: ReactNode;
}) {
  const merged = useMemo<DataLakeSurfaceTokens>(
    () => ({
      theme: { ...DEFAULT_DATA_LAKE_SURFACE_TOKENS.theme, ...tokens.theme },
      copy: { ...DEFAULT_DATA_LAKE_SURFACE_TOKENS.copy, ...tokens.copy },
      icons: { ...DEFAULT_DATA_LAKE_SURFACE_TOKENS.icons, ...tokens.icons },
      taxonomy: { ...DEFAULT_DATA_LAKE_SURFACE_TOKENS.taxonomy, ...tokens.taxonomy },
    }),
    [tokens]
  );
  return <DataLakeSurfaceContext.Provider value={merged}>{children}</DataLakeSurfaceContext.Provider>;
}

/** Tokens for the current surface; the neutral defaults when no provider is mounted. */
export const useDataLakeSurface = () => useContext(DataLakeSurfaceContext);

/** Human label for a tag segment at `depth`, falling back to a de-slugged segment. */
export function humanizeSegment(segment: string, depth: number, taxonomy: DataLakeSurfaceTaxonomy): string {
  if (depth === 0 && taxonomy.prefixLabels[segment]) return taxonomy.prefixLabels[segment];
  if (depth === 1 && taxonomy.categoryLabels[segment]) return taxonomy.categoryLabels[segment];
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
}
