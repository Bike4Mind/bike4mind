import { glob, lstat, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, matchesGlob, relative } from 'node:path';
import { git } from '../project/git';
import { resolveWithinRoots } from './paths';
import {
  capOutput,
  MAX_TOOL_OUTPUT_CHARS,
  optionalNumber,
  requireString,
  type ToolContext,
  type ToolDefinition,
} from './types';

/**
 * Directories never worth walking; they dominate results and blow the output cap. Only the
 * fallback walk needs this - inside a git work tree, .gitignore decides (see listFiles).
 */
const IGNORED = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'out',
  '.turbo',
  '.cache',
  'Library',
  'target',
  'coverage',
  '__pycache__',
]);

const MAX_MATCHES = 300;

/** How many files the fallback walk collects before giving up, so a home-folder grant cannot stall a turn. */
const MAX_WALKED_FILES = 20_000;

const MAX_SEARCH_FILE_BYTES = 2_000_000;
/** git and ripgrep use the same heuristic: a NUL byte in the first 8000 bytes means binary. */
const BINARY_SNIFF_BYTES = 8000;
const SCAN_BATCH = 64;

const DEFAULT_GREP_RESULTS = 200;
const MAX_GREP_RESULTS = 1000;
const MAX_GREP_CONTEXT = 10;
const MAX_GREP_LINE_CHARS = 240;
const MAX_LISTED_MATCHING_FILES = 500;

const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 2000;
const MAX_READ_LINE_CHARS = 2000;
/** Leaves room under the shared cap for the trailing "Lines a-b of n" note. */
const OUTPUT_BUDGET = MAX_TOOL_OUTPUT_CHARS - 500;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * Where a relative pattern is anchored: the session's working directory, or the single granted
 * root when there is exactly one and no working directory. A Code session pointed at a project
 * always has one, so "search this project" needs no path even with several folders granted.
 *
 * Nothing granted and nothing to run in is its own refusal rather than the ambiguity message:
 * that is a Code session whose folder has not been chosen yet, and telling the model to name a
 * path would invite it to guess one.
 */
function defaultBase(context: ToolContext): string {
  if (context.workingDirectory) return context.workingDirectory;
  if (context.roots.length === 1) return context.roots[0];
  if (context.roots.length === 0) throw new Error('No folder has been shared, so there is nothing to look in.');
  throw new Error(
    `Specify "path": several folders are granted (${context.roots.join(', ')}), so a relative pattern is ambiguous.`
  );
}

/** Depth-first walk that skips IGNORED and hidden directories; `onFile` returning false stops it. */
async function walk(base: string, context: ToolContext, onFile: (absolute: string) => boolean | void): Promise<void> {
  const pending = [base];
  while (pending.length > 0) {
    if (context.signal.aborted) return;
    const directory = pending.pop() as string;
    let entries;
    try {
      entries = await glob('*', { cwd: directory, withFileTypes: true });
    } catch {
      continue;
    }
    for await (const entry of entries) {
      if (context.signal.aborted) return;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name) && !entry.name.startsWith('.')) pending.push(absolute);
      } else if (entry.isFile()) {
        if (onFile(absolute) === false) return;
      }
    }
  }
}

/** Tracked and untracked-but-not-ignored files under `base`, relative to it; null outside a work tree. */
async function gitListing(base: string): Promise<string[] | null> {
  try {
    // core.fsmonitor names a program for git to run, and it comes from the repository's own
    // config: a granted folder is not necessarily a repository the user trusts.
    const output = await git(base, [
      '-c',
      'core.fsmonitor=false',
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]);
    // A nested repository shows up as its directory with a trailing slash; an unmerged path
    // once per conflict stage.
    const files = [...new Set(output.split('\0').filter(path => path && !path.endsWith('/')))];
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

interface FileListing {
  /** Relative to the base, sorted. */
  files: string[];
  /** False when the fallback walk stopped at MAX_WALKED_FILES. */
  complete: boolean;
}

/**
 * The files a search should consider. Inside a git work tree that is git's own list, so
 * .gitignore is honoured (a Rust `target/` or a build folder under any name drops out) and no
 * directory is walked at all. An empty listing - a folder that is itself ignored, such as one
 * package under node_modules - falls back to the walk so asking for it explicitly still works.
 */
async function listFiles(base: string, context: ToolContext): Promise<FileListing> {
  const tracked = await gitListing(base);
  if (tracked) return { files: tracked.sort(), complete: true };

  const files: string[] = [];
  let complete = true;
  await walk(base, context, absolute => {
    if (files.length >= MAX_WALKED_FILES) {
      complete = false;
      return false;
    }
    files.push(relative(base, absolute));
  });
  return { files: files.sort(), complete };
}

export const fileRead: ToolDefinition = {
  schema: {
    name: 'file_read',
    description:
      'Read a text file from the local filesystem. Only files inside folders the user has ' +
      'granted are readable. Each line is prefixed with its line number and a tab; those ' +
      'prefixes are not part of the file, so never copy them into file_edit. Returns at most ' +
      `${DEFAULT_READ_LINES} lines per call unless you pass a limit (up to ${MAX_READ_LINES}), and ` +
      'says where to continue. For a large file, find what you need with grep_search first ' +
      '(with context lines) and read just that range with offset/limit.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
        offset: { type: 'number', description: 'First line to return (1-based).' },
        limit: {
          type: 'number',
          description: `Maximum number of lines to return (default ${DEFAULT_READ_LINES}, at most ${MAX_READ_LINES}).`,
        },
      },
      required: ['path'],
    },
  },
  async run(input, context) {
    const target = await resolveWithinRoots(requireString(input, 'path'), context.roots, context.workingDirectory);
    const info = await stat(target);
    if (info.isDirectory()) throw new Error(`${target} is a directory. Use glob_files to list it.`);

    const buffer = await readFile(target);
    if (isBinary(buffer)) return `${target} is a binary file (${formatBytes(info.size)}), so it is not shown as text.`;

    const lines = buffer.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const total = lines.length;
    if (total === 0) return `${target} is empty.`;

    const first = Math.max(1, Math.floor(optionalNumber(input, 'offset') ?? 1));
    if (first > total) return `${target} has ${total} line${total === 1 ? '' : 's'}; offset ${first} is past the end.`;
    const wanted = Math.min(
      MAX_READ_LINES,
      Math.max(1, Math.floor(optionalNumber(input, 'limit') ?? DEFAULT_READ_LINES))
    );
    const last = Math.min(total, first + wanted - 1);

    const width = String(last).length;
    const rows: string[] = [];
    let size = 0;
    let shownTo = first - 1;
    for (let number = first; number <= last; number += 1) {
      const line = lines[number - 1];
      const text =
        line.length > MAX_READ_LINE_CHARS
          ? `${line.slice(0, MAX_READ_LINE_CHARS)}... [line cut at ${MAX_READ_LINE_CHARS} characters]`
          : line;
      const row = `${String(number).padStart(width)}\t${text}`;
      if (size + row.length + 1 > OUTPUT_BUDGET) break;
      rows.push(row);
      size += row.length + 1;
      shownTo = number;
    }

    if (first > 1 || shownTo < total) {
      const next =
        shownTo < total
          ? ` Continue with offset ${shownTo + 1}. grep_search with context is usually cheaper than paging to find a spot.`
          : '';
      rows.push('', `[Lines ${first}-${shownTo} of ${total}.${next}]`);
    }
    return rows.join('\n');
  },
};

/** Top-level folders of a listing with how many files each holds, so "*" also shows the shape of a tree. */
function summarizeFolders(files: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const slash = file.indexOf('/');
    if (slash > 0) counts.set(file.slice(0, slash), (counts.get(file.slice(0, slash)) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, count]) => `  ${folder}/ (${count} file${count === 1 ? '' : 's'})`);
}

export const globFiles: ToolDefinition = {
  schema: {
    name: 'glob_files',
    description:
      'List files matching a glob pattern, newest-modified first, with their sizes. Skips files ' +
      'ignored by .gitignore and dependency folders. "*" lists the top level of a folder, ' +
      'including its subfolders with file counts; "**/*.ts" matches at any depth. Use this to ' +
      'explore a project or find files by name, or to find the largest or most recent files.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob such as "**/*.ts", "src/**/use*.tsx" or "*". Defaults to "*".' },
        path: { type: 'string', description: 'Absolute folder to search in.' },
        sort: { type: 'string', description: '"size" or "modified" (default).' },
      },
      required: [],
    },
  },
  async run(input, context) {
    const requested = typeof input.path === 'string' && input.path ? input.path : defaultBase(context);
    const base = await resolveWithinRoots(requested, context.roots, context.workingDirectory);
    const pattern = typeof input.pattern === 'string' && input.pattern ? input.pattern : '*';

    const listing = await listFiles(base, context);
    const matched = listing.files.filter(file => matchesGlob(file, pattern));

    const found: { path: string; size: number; modified: number }[] = [];
    for (let start = 0; start < matched.length && !context.signal.aborted; start += SCAN_BATCH) {
      const batch = await Promise.all(
        matched.slice(start, start + SCAN_BATCH).map(async file => {
          try {
            const info = await stat(join(base, file));
            return info.isFile() ? { path: file, size: info.size, modified: info.mtimeMs } : null;
          } catch {
            return null; // Vanished between listing and stat, or deleted but still in the index.
          }
        })
      );
      for (const entry of batch) if (entry) found.push(entry);
    }

    const folders = pattern === '*' ? summarizeFolders(listing.files) : [];

    if (found.length === 0 && folders.length === 0) {
      const hint = pattern.includes('/')
        ? ''
        : ` A pattern without a slash only matches the top level; try "**/${pattern}".`;
      return `No files matched ${pattern} in ${base}.${hint}`;
    }

    const bySize = input.sort === 'size';
    found.sort((a, b) => (bySize ? b.size - a.size : b.modified - a.modified));

    const rows = found
      .slice(0, MAX_MATCHES)
      .map(
        entry =>
          `${formatBytes(entry.size).padStart(10)}  ${new Date(entry.modified).toISOString().slice(0, 10)}  ${entry.path}`
      );
    const shown =
      found.length > MAX_MATCHES ? `; showing the first ${MAX_MATCHES}, so narrow the pattern to see the rest` : '';
    const partial = listing.complete ? '' : ` Only the first ${MAX_WALKED_FILES} files under ${base} were considered.`;
    const header = `${found.length} file(s) in ${base}, sorted by ${bySize ? 'size' : 'modification time'}${shown}:${partial}`;
    const tail = folders.length > 0 ? ['', 'Folders:', ...folders] : [];
    return capOutput([header, ...rows, ...tail].join('\n'));
  },
};

/**
 * A pattern without a slash matches a file name at any depth, the way ripgrep's --glob does.
 * Models also write "*.ts,*.tsx" as often as the brace form, so a comma outside braces splits
 * alternatives rather than silently matching nothing.
 */
function matchesInclude(file: string, include: string): boolean {
  return splitAlternatives(include).some(
    pattern => matchesGlob(file, pattern) || (!pattern.includes('/') && matchesGlob(basename(file), pattern))
  );
}

function splitAlternatives(include: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of include) {
    if (char === '{') depth += 1;
    if (char === '}') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function clipLine(line: string, expression: RegExp, keepIndent: boolean): string {
  const text = keepIndent ? line.trimEnd() : line.trim();
  if (text.length <= MAX_GREP_LINE_CHARS) return text;
  const start = Math.max(0, text.search(expression) - 80);
  return `${start > 0 ? '...' : ''}${text.slice(start, start + MAX_GREP_LINE_CHARS)}...`;
}

/** Zero-based indexes of the matching lines, or null for a file that cannot or should not be searched. */
async function scanFile(absolute: string, expression: RegExp): Promise<{ lines: string[]; hits: number[] } | null> {
  try {
    // lstat, not stat: git lists a tracked symlink as a file, and following one could read
    // outside every granted root.
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > MAX_SEARCH_FILE_BYTES) return null;
    const buffer = await readFile(absolute);
    if (isBinary(buffer)) return null;
    const lines = buffer.toString('utf8').split('\n');
    const hits: number[] = [];
    lines.forEach((line, index) => {
      if (expression.test(line)) hits.push(index);
    });
    return hits.length > 0 ? { lines, hits } : null;
  } catch {
    return null;
  }
}

/** One file's matches as `n: line`, with `n- line` context and `--` between separate blocks. */
function formatHits(lines: readonly string[], hits: readonly number[], around: number, expression: RegExp): string[] {
  const out: string[] = [];
  const matching = new Set(hits);
  let printedTo = -1;
  for (const hit of hits) {
    const from = Math.max(0, hit - around, printedTo + 1);
    const to = Math.min(lines.length - 1, hit + around);
    if (printedTo >= 0 && from > printedTo + 1) out.push('  --');
    for (let index = from; index <= to; index += 1) {
      const marker = matching.has(index) ? ':' : '-';
      out.push(`  ${index + 1}${marker} ${clipLine(lines[index], expression, around > 0)}`);
    }
    printedTo = Math.max(printedTo, to);
  }
  return out;
}

export const grepSearch: ToolDefinition = {
  schema: {
    name: 'grep_search',
    description:
      'Search file contents with a JavaScript regular expression. Skips files ignored by ' +
      '.gitignore, binary files and dependency folders. Returns matching lines grouped by file ' +
      'with line numbers, and says when there are more than it shows. Use outputMode "files" ' +
      'to see only which files match and how often, and "include" to limit it to some files. ' +
      'Faster than grep through bash_execute, and it needs no approval.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Absolute folder to search in.' },
        include: {
          type: 'string',
          description:
            'Only search files matching this glob, e.g. "*.rs", "*.{ts,tsx}" or "src/**/*.ts". ' +
            'A glob without a slash matches the file name at any depth.',
        },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive match.' },
        outputMode: {
          type: 'string',
          description: '"content" (default): matching lines. "files": matching files with counts.',
        },
        context: {
          type: 'number',
          description: `Lines of context to show around each match (0-${MAX_GREP_CONTEXT}, default 0).`,
        },
        maxResults: {
          type: 'number',
          description: `Most matching lines to show (default ${DEFAULT_GREP_RESULTS}, at most ${MAX_GREP_RESULTS}).`,
        },
      },
      required: ['pattern'],
    },
  },
  async run(input, context) {
    const requested = typeof input.path === 'string' && input.path ? input.path : defaultBase(context);
    const base = await resolveWithinRoots(requested, context.roots, context.workingDirectory);

    let expression: RegExp;
    try {
      expression = new RegExp(requireString(input, 'pattern'), input.ignoreCase === true ? 'i' : undefined);
    } catch (err) {
      throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
    }

    const include = typeof input.include === 'string' && input.include ? input.include : undefined;
    const filesOnly = input.outputMode === 'files';
    const around = Math.min(MAX_GREP_CONTEXT, Math.max(0, Math.floor(optionalNumber(input, 'context') ?? 0)));
    const maxResults = Math.min(
      MAX_GREP_RESULTS,
      Math.max(1, Math.floor(optionalNumber(input, 'maxResults') ?? DEFAULT_GREP_RESULTS))
    );

    // A file path is a one-file search; listing it as a folder found nothing and read as "No matches".
    const single = (await stat(base).catch(() => undefined))?.isFile() === true;
    const directory = single ? dirname(base) : base;
    const listing: FileListing = single ? { files: [basename(base)], complete: true } : await listFiles(base, context);
    const candidates = include && !single ? listing.files.filter(file => matchesInclude(file, include)) : listing.files;

    const body: string[] = [];
    let size = 0;
    let shownMatches = 0;
    let totalMatches = 0;
    let matchingFiles = 0;
    let truncated = false;

    // Batches, in listing order, so the output is deterministic while reads still overlap. In
    // content mode the scan stops once the output is full: a broad pattern on a large tree
    // should come back quickly with "narrow it", not after reading every file.
    for (let start = 0; start < candidates.length && !truncated; start += SCAN_BATCH) {
      if (context.signal.aborted) break;
      const batch = candidates.slice(start, start + SCAN_BATCH);
      const scanned = await Promise.all(batch.map(file => scanFile(join(directory, file), expression)));

      for (let index = 0; index < batch.length; index += 1) {
        const result = scanned[index];
        if (!result) continue;
        matchingFiles += 1;
        totalMatches += result.hits.length;

        if (filesOnly) {
          if (body.length < MAX_LISTED_MATCHING_FILES) body.push(`${batch[index]} (${result.hits.length})`);
          continue;
        }

        const room = maxResults - shownMatches;
        const hits = result.hits.slice(0, room);
        const block = [batch[index], ...formatHits(result.lines, hits, around, expression)];
        const blockSize = block.reduce((sum, line) => sum + line.length + 1, 0);
        if (size + blockSize > OUTPUT_BUDGET && body.length > 0) {
          truncated = true;
          break;
        }
        body.push(...block);
        size += blockSize;
        shownMatches += hits.length;
        if (hits.length < result.hits.length || shownMatches >= maxResults) {
          truncated = true;
          break;
        }
      }
    }

    const scope = include ? ` in files matching ${include}` : '';
    const partial = listing.complete ? '' : ` Only the first ${MAX_WALKED_FILES} files under ${base} were searched.`;
    if (matchingFiles === 0) return `No matches for ${expression} under ${base}${scope}.${partial}`;

    let header: string;
    if (filesOnly) {
      const listed =
        matchingFiles > MAX_LISTED_MATCHING_FILES ? `; listing the first ${MAX_LISTED_MATCHING_FILES}` : '';
      header = `${matchingFiles} file(s) under ${base}${scope} match, ${totalMatches} matching line(s) in all${listed}:`;
    } else if (truncated) {
      header =
        `Showing the first ${shownMatches} matching line(s); there are more. Narrow the search with ` +
        `"include", a more specific pattern or a deeper "path", or use outputMode "files" for an overview.`;
    } else {
      header = `${totalMatches} matching line(s) in ${matchingFiles} file(s) under ${base}${scope}:`;
    }
    return capOutput([header + partial, ...body].join('\n'));
  },
};
