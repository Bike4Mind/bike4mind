import {
  ArtifactType,
  ARTIFACT_TYPE_REGISTRY,
  SupportedFabFileMimeTypes,
  SEARCH_RESULT_CARDS_LANGUAGE,
  LOCATION_MAP_LANGUAGE,
} from '@bike4mind/common';
import { parseArtifacts } from './artifactParser';
import { COMMON_FILE_FORMATS, detectFileFormat, getFormatByMimeType, FileFormatOption } from './fileFormatUtils';

export interface ReplyDownload {
  key: string;
  label: string;
  fileName: string;
  mimeType: string;
  content: string;
}

const MAX_DOWNLOADS = 10;

// Sentinels parseArtifacts fills in when the model omitted the attribute - must stay in sync
// with the defaults in artifactParser.ts's parseArtifacts (`title || 'Untitled Artifact'`,
// `language || 'text'`). Treating them as "no value" keeps an untitled/unlabeled artifact from
// getting a fake title-based filename or a bogus .txt extension from the language branch.
const UNTITLED_ARTIFACT_TITLE = 'Untitled Artifact';
const DEFAULT_ARTIFACT_LANGUAGE = 'text';

// Extension index over the existing format table (COMMON_FILE_FORMATS is keyed by mimeType via
// getFormatByMimeType; fence languages and aliases resolve by extension instead).
const FORMAT_BY_EXTENSION = new Map<string, FileFormatOption>(COMMON_FILE_FORMATS.map(f => [f.extension, f]));

// Fence language / info-string -> extension already present in COMMON_FILE_FORMATS. Anything not
// listed here falls through to detectFileFormat.
const LANGUAGE_ALIASES: Record<string, string> = {
  py: 'py',
  python: 'py',
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  csv: 'csv',
  json: 'json',
  yaml: 'yml',
  yml: 'yml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  xml: 'xml',
  md: 'md',
  markdown: 'md',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  bash: 'bash',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  cs: 'cs',
  csharp: 'cs',
  java: 'java',
  go: 'go',
  golang: 'go',
  rs: 'rs',
  rust: 'rs',
  rb: 'rb',
  ruby: 'rb',
  php: 'php',
  swift: 'swift',
  kt: 'kt',
  kotlin: 'kt',
  toml: 'toml',
  txt: 'txt',
  text: 'txt',
  plain: 'txt',
};

// Languages a model plausibly emits that COMMON_FILE_FORMATS does not carry (it is scoped to
// knowledge-file save formats). Declared with an explicit extension so a download keeps the
// language that was actually written - a C file saved as .cpp is a different language, and a
// SQL file saved as .txt loses the one signal a user would search for it by. TXT_PLAIN is
// deliberate for both: the mime only sets the Blob type and is near-irrelevant to the download,
// whereas claiming e.g. text/x-c++src for a C file would be a second wrong claim.
const LANGUAGE_EXTRAS: Record<string, FileFormatOption> = {
  c: { label: 'C', extension: 'c', mimeType: SupportedFabFileMimeTypes.TXT_PLAIN },
  sql: { label: 'SQL', extension: 'sql', mimeType: SupportedFabFileMimeTypes.TXT_PLAIN },
};

interface ExtractedBlock {
  content: string;
  language?: string;
  artifactType?: ArtifactType;
  title?: string;
}

function resolveByLanguageAlias(language: string): FileFormatOption | null {
  const key = language.trim().toLowerCase();
  if (LANGUAGE_EXTRAS[key]) return LANGUAGE_EXTRAS[key];
  const ext = LANGUAGE_ALIASES[key];
  return ext ? (FORMAT_BY_EXTENSION.get(ext) ?? null) : null;
}

function resolveByArtifactType(type: ArtifactType): FileFormatOption | null {
  // image/svg+xml has no entry in COMMON_FILE_FORMATS (that table is scoped to knowledge-file
  // save formats, which never included SVG), so it needs its own case rather than a lookup.
  if (type === 'svg') {
    return { label: ARTIFACT_TYPE_REGISTRY.svg.name, extension: 'svg', mimeType: SupportedFabFileMimeTypes.SVG };
  }
  return getFormatByMimeType(ARTIFACT_TYPE_REGISTRY[type].mimeType) ?? null;
}

function resolveFormat(block: ExtractedBlock): FileFormatOption {
  if (block.language) {
    const byLanguage = resolveByLanguageAlias(block.language);
    if (byLanguage) return byLanguage;
  }
  if (block.artifactType) {
    const byType = resolveByArtifactType(block.artifactType);
    if (byType) return byType;
  }
  try {
    return detectFileFormat(block.content);
  } catch {
    // detectFileFormat should not throw, but this is a degrade path, not a user-visible failure.
    return FORMAT_BY_EXTENSION.get('txt')!;
  }
}

function slugifyTitle(title: string, maxLen = 40): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
}

function uniqueFileName(base: string, extension: string, used: Set<string>): string {
  let fileName = `${base}.${extension}`;
  let n = 2;
  while (used.has(fileName)) {
    fileName = `${base}-${n}.${extension}`;
    n++;
  }
  used.add(fileName);
  return fileName;
}

function extractFenceBlocks(cleanedContent: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  try {
    const fenceRegex = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(cleanedContent)) !== null) {
      try {
        const infoString = match[1].trim();
        if (!infoString) continue; // no language attached - not worth a download entry
        const language = infoString.split(/\s+/)[0]?.toLowerCase();
        // Model-authored card/map JSON, not a downloadable file.
        if (language === SEARCH_RESULT_CARDS_LANGUAGE || language === LOCATION_MAP_LANGUAGE) continue;
        const body = match[2];
        const nonEmptyLines = body.split('\n').filter(line => line.trim().length > 0);
        if (nonEmptyLines.length < 2) continue; // too small to be worth a download entry
        blocks.push({ content: body.trim(), language });
      } catch {
        continue; // one malformed fence should not drop the rest
      }
    }
  } catch {
    // extraction failure degrades to zero fence blocks - never throws
  }
  return blocks;
}

/**
 * Builds the list of downloadable files embedded in a chat reply: `<artifact>` blocks plus
 * any remaining fenced code blocks. `baseName` (typically the message id) seeds filenames for
 * blocks with no usable title. Never throws - a malformed fence or artifact degrades to fewer
 * entries rather than an exception, since this feeds a download menu, not a critical path.
 */
export function buildReplyDownloads(reply: string, baseName: string): ReplyDownload[] {
  if (!reply || !reply.trim()) return [];

  let artifactBlocks: ExtractedBlock[] = [];
  let cleanedContent = reply;
  try {
    const parsed = parseArtifacts(reply);
    cleanedContent = parsed.cleanedContent;
    // parseArtifacts leaves its artifacts array in descending-startIndex order (an artifact of
    // how it strips tags from the content); re-sort to reading order for stable numbering.
    artifactBlocks = [...parsed.artifacts]
      .sort((a, b) => a.startIndex - b.startIndex)
      .map(a => ({
        content: a.content,
        language: a.language && a.language !== DEFAULT_ARTIFACT_LANGUAGE ? a.language : undefined,
        artifactType: a.type,
        title: a.title && a.title !== UNTITLED_ARTIFACT_TITLE ? a.title : undefined,
      }));
  } catch {
    // Parse failure: fall through and scan the raw reply for fences instead of throwing.
  }

  const fenceBlocks = extractFenceBlocks(cleanedContent);
  const blocks = [...artifactBlocks, ...fenceBlocks];

  const used = new Set<string>();
  const downloads: ReplyDownload[] = [];
  let counter = 0;

  for (const block of blocks) {
    counter += 1;
    try {
      const format = resolveFormat(block);
      const slug = block.title ? slugifyTitle(block.title) : '';
      const fileBase = slug.length > 0 ? slug : `${baseName}-${counter}`;
      const fileName = uniqueFileName(fileBase, format.extension, used);
      const label = block.title ? `${block.title} (${format.label})` : format.label;

      downloads.push({
        key: fileName,
        label,
        fileName,
        mimeType: format.mimeType,
        content: block.content,
      });
    } catch {
      continue; // one bad block should not drop the rest
    }

    if (downloads.length >= MAX_DOWNLOADS) break;
  }

  return downloads;
}
