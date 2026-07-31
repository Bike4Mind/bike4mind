import type {
  InferTaxonomyResponse,
  TaxonomyFileAssignment,
  TaxonomyTag,
  TaxonomyTagSet,
} from '../types/entities/DataLakeTypes';

export interface AppliedTag {
  name: string;
  strength: number;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const clampStrength = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;

/**
 * The editable suffix is the tag name with its inferred prefix stripped, so the prefix is
 * never stored per-tag (it lives once in the caller's tagPrefix). A name that does not carry
 * the inferred prefix keeps its whole text as the suffix.
 */
const deriveSuffix = (fullName: string, sourcePrefix: string): string => {
  const trimmed = fullName.trim();
  if (!sourcePrefix) return trimmed;
  const p = sourcePrefix.endsWith(':') ? sourcePrefix : `${sourcePrefix}:`;
  return trimmed.toLowerCase().startsWith(p.toLowerCase()) ? trimmed.slice(p.length) : trimmed;
};

/**
 * Split each inferred category into its stable full name (originalName, the join key for
 * per-file assignments) and its editable suffix. Drops entries the model returned without a
 * usable tag name, or that reduce to an empty suffix (the tag was nothing but the prefix).
 * The single boundary where raw inference JSON becomes trusted `TaxonomyTag[]` - called by
 * both the wizard (historically) and the post-upload background job, so a malformed
 * model response can never propagate past here.
 */
export function sanitizeCategories(
  categories: InferTaxonomyResponse['categories'],
  sourcePrefix: string
): TaxonomyTag[] {
  if (!Array.isArray(categories)) return [];
  // originalName is the join key for update/delete/merge, so it must be unique: a model that
  // repeats a tagName would otherwise make one card's edit hit both.
  const seen = new Set<string>();
  return categories
    .filter(cat => cat && isNonEmptyString(cat.tagName))
    .map(cat => {
      const originalName = cat.tagName.trim();
      return {
        suffix: deriveSuffix(originalName, sourcePrefix),
        originalName,
        strength: clampStrength(cat.confidence, 0.7),
        source: 'ai' as const,
        matchingFolders: Array.isArray(cat.matchingFolders) ? cat.matchingFolders.filter(isNonEmptyString) : [],
        deleted: false,
      };
    })
    .filter(t => {
      if (t.suffix.length === 0) return false;
      const key = t.originalName.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function sanitizeFileAssignments(
  assignments: InferTaxonomyResponse['fileAssignments']
): TaxonomyFileAssignment[] {
  if (!Array.isArray(assignments)) return [];
  return assignments
    .filter(entry => entry && isNonEmptyString(entry.relativePath))
    .map(entry => ({
      // Trim on write to match how categories are stored: tagsForFile matches assignments by
      // strict path equality, so a padded path would otherwise miss its per-file suggestions.
      relativePath: entry.relativePath.trim(),
      suggestedTags: Array.isArray(entry.suggestedTags)
        ? entry.suggestedTags
            .filter(tag => tag && isNonEmptyString(tag.name))
            .map(tag => ({ name: tag.name.trim(), strength: clampStrength(tag.strength, 0.7) }))
        : [],
    }));
}

/**
 * A single file can pick up a tag from every category whose folders it sits under.
 * Cap it so a pathological inference result (every category matching the root) can't
 * bury a file under dozens of tags; the highest-strength ones win. Caps taxonomy tags
 * only - the folder tag is added on top, so a file can carry this many + 1.
 */
const MAX_TAXONOMY_TAGS_PER_FILE = 8;

const ensureColon = (prefix: string): string => (prefix.endsWith(':') ? prefix : `${prefix}:`);

/**
 * One normalization shared by the folder tag and folder matching. Both sides must agree:
 * a folder named "Legal Docs" is tagged `prefix:legal_docs`, so a category listing it as
 * either "Legal Docs" or "legal_docs" has to match the same file.
 */
const slugifySegment = (segment: string): string =>
  segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const normalizeSegments = (path: string): string[] => path.split('/').map(slugifySegment).filter(Boolean);

/**
 * Derive a single tag for a file from its immediate parent folder, so each file
 * is tagged by its source folder rather than getting every taxonomy category.
 * Returns [] for root-level files (they get only the lake meta-tag). Uses
 * underscores to match the AI taxonomy's folder-slug style.
 */
export function folderTagForFile(relativePath: string, tagPrefix: string): AppliedTag[] {
  const segments = relativePath.split('/').filter(Boolean);
  const parent = segments.length >= 2 ? segments[segments.length - 2] : undefined;
  if (!parent) return [];
  const slug = slugifySegment(parent);
  if (!slug) return [];
  return [{ name: `${ensureColon(tagPrefix)}${slug}`, strength: 1.0 }];
}

/**
 * Inference returns folder paths ("legal/agreements"), not bare folder names, and a
 * category covers everything beneath its folders. So match the entry as a contiguous
 * run of segments anywhere in the file's folder path.
 */
export function folderMatches(fileFolderSegments: string[], matchingFolder: string): boolean {
  const target = normalizeSegments(matchingFolder);
  if (target.length === 0) return false;
  for (let i = 0; i + target.length <= fileFolderSegments.length; i++) {
    if (target.every((seg, j) => fileFolderSegments[i + j] === seg)) return true;
  }
  return false;
}

/**
 * Tags to apply to one file: the folder tag (always, so folder structure stays queryable
 * and every nested file gets at least one tag) plus the reviewed taxonomy categories
 * covering it. Deleted categories are dropped, and each category's applied name is
 * `prefix + suffix`, so the shared prefix (also the folder tag's) guarantees one namespace
 * per lake. Per-file assignments are matched via each tag's originalName (the inference join
 * key). An empty `taxonomy` (no categories reviewed/accepted) falls back to the folder tag
 * alone - this is both the original create path (no AI step) and any lake where AI tagging
 * was never opted into.
 */
export function tagsForFile(relativePath: string, taxonomy: TaxonomyTagSet, tagPrefix: string): AppliedTag[] {
  const folderTags = folderTagForFile(relativePath, tagPrefix);
  const active = taxonomy.tags.filter(t => !t.deleted);
  if (active.length === 0) return folderTags;

  const prefix = ensureColon(tagPrefix);
  const byOriginalName = new Map(active.map(t => [t.originalName.toLowerCase(), t]));
  const fileFolderSegments = normalizeSegments(relativePath.split('/').slice(0, -1).join('/'));
  const strongest = new Map<string, number>();

  const add = (name: string, strength: number) => {
    const current = strongest.get(name);
    if (current === undefined || strength > current) strongest.set(name, strength);
  };

  // Per-file assignments are richer than folder matching but only cover the sampled
  // files, so they layer on top rather than replacing the folder pass below.
  const assignment = taxonomy.fileAssignments.find(a => a.relativePath === relativePath);
  for (const suggested of assignment?.suggestedTags ?? []) {
    const tag = byOriginalName.get(suggested.name.toLowerCase());
    if (!tag) continue; // deleted by the reviewer, or a tag the model never declared as a category
    add(`${prefix}${tag.suffix}`, suggested.strength);
  }

  for (const tag of active) {
    if (tag.matchingFolders.some(folder => folderMatches(fileFolderSegments, folder))) {
      add(`${prefix}${tag.suffix}`, tag.strength);
    }
  }

  const taxonomyTags = Array.from(strongest, ([name, strength]) => ({ name, strength }))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_TAXONOMY_TAGS_PER_FILE);

  const seen = new Set(taxonomyTags.map(t => t.name));
  return [...taxonomyTags, ...folderTags.filter(t => !seen.has(t.name))];
}

/** Union of every tag a set of files will carry, for the batch record's appliedTags summary. */
export function appliedTagsForBatch(
  files: { relativePath: string }[],
  taxonomy: TaxonomyTagSet,
  tagPrefix: string
): AppliedTag[] {
  const strongest = new Map<string, number>();
  for (const file of files) {
    for (const tag of tagsForFile(file.relativePath, taxonomy, tagPrefix)) {
      const current = strongest.get(tag.name);
      if (current === undefined || tag.strength > current) strongest.set(tag.name, tag.strength);
    }
  }
  return Array.from(strongest, ([name, strength]) => ({ name, strength }));
}
