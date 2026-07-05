/**
 * TypeScript types for the Help system
 */

export type HelpAccessLevel = 'public' | 'admin';

export interface HelpHeading {
  level: number; // 1-6 for h1-h6
  text: string; // The heading text
  anchor: string; // Generated anchor ID (e.g., "search-capabilities")
}

export interface HelpIndexEntry {
  slug: string; // URL path (e.g., "features/knowledge-management")
  title: string; // From frontmatter
  description: string; // From frontmatter
  category: string; // From directory path (e.g., "features")
  sidebarPosition: number; // From frontmatter, for ordering
  tags: string[]; // From frontmatter (optional)
  headings: HelpHeading[]; // Extracted from content
  filePath: string; // Relative path to the markdown file
  accessLevel: HelpAccessLevel; // 'public' for user docs, 'admin' for admin-only docs
}

export interface HelpCategory {
  name: string; // Category name (e.g., "features")
  label: string; // Display label (e.g., "Features")
  entries: HelpIndexEntry[];
  subcategories: HelpCategory[];
  sidebarPosition: number;
  accessLevel?: HelpAccessLevel; // If set, all entries in this category share this access level
}

export interface HelpIndex {
  entries: HelpIndexEntry[];
  categories: HelpCategory[];
  version: string; // Build version/timestamp
}

export interface HelpFrontmatter {
  title?: string;
  description?: string;
  sidebar_position?: number;
  tags?: string[];
  sidebar_label?: string;
}

export interface HelpEmbeddingChunk {
  slug: string; // Matches HelpIndexEntry.slug
  title: string; // Article title
  sectionPath: string; // e.g. "Creating an Agent > Basic Information"
  vector: number[]; // Embedding vector (dimensions set at build time)
  tokenCount: number; // Token count for budget management (computed at build time from content)
  accessLevel: HelpAccessLevel; // 'public' for user docs, 'admin' for admin-only docs
}

export interface HelpEmbeddingsIndex {
  chunks: HelpEmbeddingChunk[];
  model: string; // e.g. "text-embedding-3-small"
  dimensions: number; // 1536
  generatedAt: string; // ISO timestamp
  sourceArticleCount: number;
}
