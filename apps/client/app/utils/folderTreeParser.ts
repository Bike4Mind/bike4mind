/**
 * Parses File[] from webkitdirectory input into a tree structure.
 * Used by the Data Lake Wizard to display folder hierarchies and compute file stats.
 */

import { SupportedFabFileMimeTypes } from '@bike4mind/common';

// Types

export interface WizardFile {
  file: File;
  relativePath: string;
  size: number;
  type: string;
  excluded: boolean;
  isDuplicate: boolean;
  existingFileId?: string;
  contentHash?: string;
}

export interface FolderTreeNode {
  name: string;
  /** Full relative path, e.g. "contracts/2024" */
  path: string;
  children: FolderTreeNode[];
  files: WizardFile[];
  /** Recursive file count (includes children) */
  fileCount: number;
  /** Recursive total size in bytes (includes children) */
  totalSize: number;
  /** Whether this folder is excluded from upload */
  excluded: boolean;
}

export interface FileTypeBreakdown {
  count: number;
  totalSize: number;
}

// Constants

export const DEFAULT_EXCLUDED_PATTERNS = [
  '.DS_Store',
  'Thumbs.db',
  '.git',
  'node_modules',
  '__MACOSX',
  '.Spotlight-V100',
  '.Trashes',
  'desktop.ini',
  '.gitkeep',
  '.gitignore',
];

const FILE_TYPE_MAP: Record<string, string> = {
  // Documents
  pdf: 'PDF',
  // Word
  doc: 'Word',
  docx: 'Word',
  // Excel
  xls: 'Excel',
  xlsx: 'Excel',
  // CSV
  csv: 'CSV',
  // JSON
  json: 'JSON',
  // Markdown
  md: 'Markdown',
  mdx: 'Markdown',
  // Images
  png: 'Image',
  jpg: 'Image',
  jpeg: 'Image',
  gif: 'Image',
  svg: 'Image',
  webp: 'Image',
  // Code
  ts: 'Code',
  tsx: 'Code',
  js: 'Code',
  jsx: 'Code',
  py: 'Code',
  rb: 'Code',
  go: 'Code',
  rs: 'Code',
  java: 'Code',
  c: 'Code',
  cpp: 'Code',
  h: 'Code',
  // Text
  txt: 'Text',
  log: 'Text',
  // HTML
  html: 'HTML',
  htm: 'HTML',
  // PowerPoint
  ppt: 'PowerPoint',
  pptx: 'PowerPoint',
};

// Exclusion matching

function isExcluded(name: string, patterns: string[]): boolean {
  const nameLower = name.toLowerCase();
  return patterns.some(pattern => {
    const patternLower = pattern.toLowerCase().trim();
    if (!patternLower) return false;
    // Extension glob: "*.m4a" matches any name ending in that extension.
    if (patternLower.startsWith('*.')) {
      return nameLower.endsWith(patternLower.slice(1));
    }
    // Exact match or the name starts with the pattern (for hidden files like .git*)
    return nameLower === patternLower || nameLower.startsWith(patternLower + '/');
  });
}

function isFileExcluded(relativePath: string, patterns: string[]): boolean {
  const segments = relativePath.split('/');
  return segments.some(segment => isExcluded(segment, patterns));
}

// Tree building

/**
 * Parses a File[] (from a webkitdirectory input) into a folder tree.
 *
 * Each File's webkitRelativePath looks like: "MyFolder/subfolder/file.txt"
 * We build a tree from these paths.
 */
export function parseFilesToTree(files: File[], excludedPatterns: string[]): FolderTreeNode {
  const root: FolderTreeNode = {
    name: '',
    path: '',
    children: [],
    files: [],
    fileCount: 0,
    totalSize: 0,
    excluded: false,
  };

  // Detect root folder name from first file's path
  if (files.length > 0) {
    const firstPath = files[0].webkitRelativePath || files[0].name;
    const firstSegment = firstPath.split('/')[0];
    if (firstSegment) {
      root.name = firstSegment;
      root.path = firstSegment;
    }
  }

  // Map of path -> FolderTreeNode for quick lookup
  const nodeMap = new Map<string, FolderTreeNode>();
  nodeMap.set(root.path, root);

  for (const file of files) {
    const relativePath = file.webkitRelativePath || file.name;
    const segments = relativePath.split('/');
    const fileName = segments[segments.length - 1];

    // Build/find intermediate folder nodes
    let currentPath = '';
    let parentNode = root;

    // Skip last segment (it's the file name), but also handle root folder
    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${segments[i]}` : segments[i];

      let node = nodeMap.get(currentPath);
      if (!node) {
        node = {
          name: segments[i],
          path: currentPath,
          children: [],
          files: [],
          fileCount: 0,
          totalSize: 0,
          excluded: isExcluded(segments[i], excludedPatterns),
        };
        nodeMap.set(currentPath, node);
        parentNode.children.push(node);
      }
      parentNode = node;
    }

    // Create the WizardFile and add to the leaf folder
    const wizardFile: WizardFile = {
      file,
      relativePath,
      size: file.size,
      type: file.type || guessMimeType(fileName),
      excluded: isFileExcluded(relativePath, excludedPatterns),
      isDuplicate: false,
    };

    parentNode.files.push(wizardFile);
  }

  // Sort children alphabetically at each level
  sortTree(root);

  // Compute recursive counts
  computeCounts(root);

  return root;
}

function sortTree(node: FolderTreeNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of node.children) {
    sortTree(child);
  }
}

function computeCounts(node: FolderTreeNode): void {
  let fileCount = 0;
  let totalSize = 0;

  // Count direct files (non-excluded)
  for (const f of node.files) {
    if (!f.excluded && !node.excluded) {
      fileCount++;
      totalSize += f.size;
    }
  }

  // Recurse into children
  for (const child of node.children) {
    computeCounts(child);
    if (!child.excluded) {
      fileCount += child.fileCount;
      totalSize += child.totalSize;
    }
  }

  node.fileCount = fileCount;
  node.totalSize = totalSize;
}

// File type breakdown

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === fileName.length - 1) return '';
  return fileName.slice(dotIndex + 1).toLowerCase();
}

/**
 * Maps a file extension to its MIME type. Every mapped value is a
 * `SupportedFabFileMimeTypes` member, so extensions the ingest pipeline can
 * actually vectorize resolve to a supported type, while everything else falls
 * through to `application/octet-stream` (treated as unsupported at upload). This
 * mirrors the server-side allow-list (`resolveSupportedMimeType`).
 */
function guessMimeType(fileName: string): string {
  const ext = getExtension(fileName);
  const M = SupportedFabFileMimeTypes;
  const mimeMap: Record<string, SupportedFabFileMimeTypes> = {
    // Documents & text
    pdf: M.PDF,
    txt: M.TXT_PLAIN,
    log: M.TXT_PLAIN,
    ini: M.TXT_PLAIN,
    env: M.TXT_PLAIN,
    conf: M.TXT_PLAIN,
    md: M.TXT_MARKDOWN,
    mdx: M.TXT_MARKDOWN,
    csv: M.CSV,
    json: M.JSON,
    html: M.HTML,
    htm: M.HTML,
    xml: M.XML,
    docx: M.DOCX,
    pptx: M.PPTX,
    xls: M.XLS,
    xlsx: M.XLSX,
    // Images
    png: M.PNG,
    jpg: M.JPG,
    jpeg: M.JPG,
    gif: M.GIF,
    svg: M.SVG,
    webp: M.WEBP,
    // Code
    js: M.JS,
    jsx: M.JSX,
    ts: M.TS,
    tsx: M.TSX,
    py: M.PY,
    java: M.JAVA,
    cpp: M.CPP,
    cs: M.CS,
    php: M.PHP,
    rb: M.RUBY,
    go: M.GO,
    swift: M.SWIFT,
    kt: M.KOTLIN,
    rs: M.RUST,
    css: M.CSS,
    less: M.LESS,
    sass: M.SASS,
    scss: M.SCSS,
    // Data serialization
    yaml: M.YAML,
    yml: M.YAML,
    toml: M.TOML,
    // Shell scripts
    sh: M.SH,
    bash: M.BASH,
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * Returns a breakdown of file types and their counts/sizes.
 * Only includes non-excluded files.
 */
export function getFileTypeBreakdown(files: WizardFile[]): Record<string, FileTypeBreakdown> {
  const breakdown: Record<string, FileTypeBreakdown> = {};

  for (const f of files) {
    if (f.excluded) continue;
    const ext = getExtension(f.file.name);
    const category = FILE_TYPE_MAP[ext] || 'Other';

    if (!breakdown[category]) {
      breakdown[category] = { count: 0, totalSize: 0 };
    }
    breakdown[category].count++;
    breakdown[category].totalSize += f.size;
  }

  return breakdown;
}

// Helpers

/**
 * Walks the tree and returns all non-excluded files from non-excluded folders.
 */
export function getIncludedFiles(node: FolderTreeNode): WizardFile[] {
  const result: WizardFile[] = [];

  if (node.excluded) return result;

  for (const f of node.files) {
    if (!f.excluded) {
      result.push(f);
    }
  }

  for (const child of node.children) {
    result.push(...getIncludedFiles(child));
  }

  return result;
}

/**
 * Collects all WizardFile objects from the tree (including excluded).
 */
export function getAllFiles(node: FolderTreeNode): WizardFile[] {
  const result: WizardFile[] = [...node.files];
  for (const child of node.children) {
    result.push(...getAllFiles(child));
  }
  return result;
}

/**
 * Formats bytes into a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Toggles exclusion on a folder by path. Returns a new tree (immutable update).
 */
export function toggleFolderExclusion(root: FolderTreeNode, targetPath: string): FolderTreeNode {
  function toggle(node: FolderTreeNode): FolderTreeNode {
    if (node.path === targetPath) {
      return { ...node, excluded: !node.excluded };
    }
    const updatedChildren = node.children.map(toggle);
    if (updatedChildren === node.children) return node;
    return { ...node, children: updatedChildren };
  }

  const updated = toggle(root);
  computeCounts(updated);
  return updated;
}

/**
 * Re-applies exclusion patterns to all files and folders in the tree.
 */
export function reapplyExclusions(root: FolderTreeNode, patterns: string[]): FolderTreeNode {
  function apply(node: FolderTreeNode): FolderTreeNode {
    const updatedFiles = node.files.map(f => ({
      ...f,
      excluded: isFileExcluded(f.relativePath, patterns),
    }));
    const updatedChildren = node.children.map(child => {
      const updated = apply(child);
      return {
        ...updated,
        excluded: isExcluded(updated.name, patterns),
      };
    });
    return { ...node, files: updatedFiles, children: updatedChildren };
  }

  const updated = apply(root);
  computeCounts(updated);
  return updated;
}

/**
 * Computes SHA-256 hash of a File using the Web Crypto API.
 */
export async function computeFileHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Returns the count of files that were excluded by the default patterns.
 */
export function countExcludedFiles(node: FolderTreeNode): number {
  let count = 0;
  for (const f of node.files) {
    if (f.excluded) count++;
  }
  for (const child of node.children) {
    if (child.excluded) {
      count += countAllFilesInNode(child);
    } else {
      count += countExcludedFiles(child);
    }
  }
  return count;
}

function countAllFilesInNode(node: FolderTreeNode): number {
  let count = node.files.length;
  for (const child of node.children) {
    count += countAllFilesInNode(child);
  }
  return count;
}
