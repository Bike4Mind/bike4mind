import { glob, lstat, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, matchesGlob, relative } from 'node:path';
import { git } from '../project/git';
import { envReadPrompt, readsEnvFile } from './envFiles';
import { resolveWithinRoots } from './paths';
import { recordRecentFile } from './recentFiles';
import { ripgrepSearch, type RipgrepFile } from './ripgrep';
import {
  capOutput,
  MAX_FILE_READ_OUTPUT_CHARS,
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

const MAX_READ_LINES = 2000;
const MAX_READ_LINE_CHARS = 2000;
/** Leaves room under file_read's own cap for the trailing "Lines a-b of n" note. */
const OUTPUT_BUDGET = MAX_FILE_READ_OUTPUT_CHARS - 500;

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

/** Files git tracks that .gitignore also matches: rg skips them, the git listing does not. */
async function trackedButIgnored(base: string): Promise<string[]> {
  try {
    const output = await git(base, [
      '-c',
      'core.fsmonitor=false',
      'ls-files',
      '-z',
      '--cached',
      '--ignored',
      '--exclude-standard',
    ]);
    return output.split('\0').filter(path => path && !path.endsWith('/'));
  } catch {
    return [];
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
      `granted are readable. Reads up to ${MAX_READ_LINES} lines from the start of the file by ` +
      'default. You can pass offset and limit when you already know which part of the file you ' +
      'need, or when the file is too large to read at once. Lines longer than ' +
      `${MAX_READ_LINE_CHARS} characters are cut. Each line is prefixed with its line number and ` +
      'a tab; those prefixes are not part of the file, so never copy them into an edit or a patch. When ' +
      'the output stops before the end of the file, it says the offset to continue from. Avoid ' +
      'repeated small slices (around 30 lines): when you need more context, read a larger window in ' +
      'one call. ' +
      'Independent calls placed in one reply run in parallel, so batch them instead of issuing one per turn.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
        offset: {
          type: 'number',
          description:
            'Line number to start reading from (1-based). Pass it only when you know which part you need or the file is too large to read at once.',
        },
        limit: {
          type: 'number',
          description: `Number of lines to read (at most ${MAX_READ_LINES}). Pass it only when you know which part you need or the file is too large to read at once.`,
        },
      },
      required: ['path'],
    },
  },
  needsApproval: (input, context) => readsEnvFile(input.path, context),
  approval: (input, context) => envReadPrompt('file_read', input.path, context),
  async run(input, context) {
    const target = await resolveWithinRoots(requireString(input, 'path'), context.roots, context.workingDirectory);
    const info = await stat(target);
    if (info.isDirectory()) throw new Error(`${target} is a directory. Use glob_files to list it.`);
    recordRecentFile(context, target);

    const buffer = await readFile(target);
    if (isBinary(buffer)) return `${target} is a binary file (${formatBytes(info.size)}), so it is not shown as text.`;

    const lines = buffer.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const total = lines.length;
    if (total === 0) return `${target} is empty.`;

    const first = Math.max(1, Math.floor(optionalNumber(input, 'offset') ?? 1));
    if (first > total) return `${target} has ${total} line${total === 1 ? '' : 's'}; offset ${first} is past the end.`;
    const wanted = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(optionalNumber(input, 'limit') ?? MAX_READ_LINES)));
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
      // contextPruning.ts parses this trailer to learn which lines a read covered.
      const cutByBudget = shownTo < last ? ' The rest did not fit in one result.' : '';
      const next = shownTo < total ? ` Continue with offset ${shownTo + 1}.${cutByBudget}` : '';
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
      'explore a project or find files by name, or to find the largest or most recent files. ' +
      'Independent calls placed in one reply run in parallel, so batch them instead of issuing one per turn.',
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    if (lines.at(-1) === '') lines.pop();
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

/** What the search has gathered so far, shared by the ripgrep and the JavaScript engines. */
function createTally(filesOnly: boolean, maxResults: number) {
  const tally = {
    body: [] as string[],
    size: 0,
    shownMatches: 0,
    totalMatches: 0,
    matchingFiles: 0,
    truncated: false,
    /** `render(n)` yields the file's first n hits with context; false means the output is full. */
    add(path: string, hitCount: number, render: (shown: number) => string[]): boolean {
      tally.matchingFiles += 1;
      tally.totalMatches += hitCount;

      if (filesOnly) {
        if (tally.body.length < MAX_LISTED_MATCHING_FILES) tally.body.push(`${path} (${hitCount})`);
        return true;
      }

      const shown = Math.min(maxResults - tally.shownMatches, hitCount);
      const block = [path, ...render(shown)];
      const blockSize = block.reduce((sum, line) => sum + line.length + 1, 0);
      if (tally.size + blockSize > OUTPUT_BUDGET && tally.body.length > 0) {
        tally.truncated = true;
        return false;
      }
      tally.body.push(...block);
      tally.size += blockSize;
      tally.shownMatches += shown;
      if (shown < hitCount || tally.shownMatches >= maxResults) {
        tally.truncated = true;
        return false;
      }
      return true;
    },
  };
  return tally;
}

/** The first `shown` hits of a ripgrep file, formatted as formatHits does for the JavaScript scan. */
function renderRipgrepFile(file: RipgrepFile, shown: number, around: number, expression: RegExp): string[] {
  let seen = 0;
  let lastNumber = Infinity;
  for (const line of file.lines) {
    if (line.match && (seen += 1) === shown) lastNumber = line.number + around;
  }

  const out: string[] = [];
  let counted = 0;
  let previous = 0;
  for (const line of file.lines) {
    if (line.number > lastNumber) break;
    if (line.match) counted += 1;
    if (previous > 0 && line.number > previous + 1) out.push('  --');
    out.push(
      `  ${line.number}${line.match && counted <= shown ? ':' : '-'} ${clipLine(line.text, expression, around > 0)}`
    );
    previous = line.number;
  }
  return out;
}

export const grepSearch: ToolDefinition = {
  schema: {
    name: 'grep_search',
    description:
      'Search file contents with a regular expression (JavaScript syntax; \\d, \\w and \\s also match ' +
      'non-ASCII characters). Skips files ignored by ' +
      '.gitignore, binary files and dependency folders. Returns matching lines grouped by file ' +
      'with line numbers, and says when there are more than it shows. Use outputMode "files" ' +
      'to see only which files match and how often, and "include" to limit it to some files. ' +
      'Faster than grep through bash_execute, and it needs no approval. ' +
      'Independent calls placed in one reply run in parallel, so batch them instead of issuing one per turn.',
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
        literal: {
          type: 'boolean',
          description:
            'Search for the pattern as plain text instead of a regular expression. Use it for text with ' +
            'unescaped ( [ { . * + ? | characters. A pattern that is not a valid regular expression is ' +
            'searched this way automatically.',
        },
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
  // Only a search aimed at one file by name: a folder search skips gitignored files, which is
  // where a `.env` nearly always is.
  needsApproval: (input, context) => readsEnvFile(input.path, context),
  approval: (input, context) => envReadPrompt('grep_search', input.path, context),
  async run(input, context) {
    const requested = typeof input.path === 'string' && input.path ? input.path : defaultBase(context);
    const base = await resolveWithinRoots(requested, context.roots, context.workingDirectory);

    const requestedPattern = requireString(input, 'pattern');
    const flags = input.ignoreCase === true ? 'i' : undefined;
    let pattern = requestedPattern;
    let note = '';
    if (input.literal === true) {
      pattern = escapeRegExp(requestedPattern);
    } else {
      try {
        new RegExp(requestedPattern, flags);
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err)).replace(
          /^Invalid regular expression: (?:\/.*\/[a-z]*: )?/,
          ''
        );
        pattern = escapeRegExp(requestedPattern);
        note =
          `Note: "${requestedPattern}" is not a valid regular expression (${reason}), so it was searched as literal text. ` +
          'Escape ( ) [ ] { } . * + ? | ^ $ \\ to use them as regex.\n';
      }
    }
    const expression = new RegExp(pattern, flags);

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

    const tally = createTally(filesOnly, maxResults);

    const viaRipgrep =
      !single &&
      (await ripgrepSearch({
        pattern,
        cwd: directory,
        ignoreCase: input.ignoreCase === true,
        context: around,
        exclude: [...IGNORED].flatMap(name => [name, `**/${name}`]),
        maxFileBytes: MAX_SEARCH_FILE_BYTES,
        signal: context.signal,
        // Filtered here rather than with rg --glob, which would also override .gitignore.
        onFile: file =>
          (include !== undefined && !matchesInclude(file.path, include)) ||
          tally.add(file.path, file.matches, shown => renderRipgrepFile(file, shown, around, expression)),
      }));

    // rg lists files itself with no walk cap, so a search it ran leaves nothing unsearched.
    let complete = true;
    const ranRipgrep = viaRipgrep === 'done' || viaRipgrep === 'stopped' || viaRipgrep === 'timed-out';
    if (ranRipgrep && viaRipgrep === 'done') {
      // rg honours .gitignore even for a file git tracks; the JavaScript listing does not.
      for (const file of await trackedButIgnored(directory)) {
        if (tally.truncated || context.signal.aborted) break;
        if (include && !matchesInclude(file, include)) continue;
        const result = await scanFile(join(directory, file), expression);
        if (result) {
          tally.add(file, result.hits.length, shown =>
            formatHits(result.lines, result.hits.slice(0, shown), around, expression)
          );
        }
      }
    }
    if (!ranRipgrep) {
      const listing: FileListing = single
        ? { files: [basename(base)], complete: true }
        : await listFiles(base, context);
      complete = listing.complete;
      const candidates =
        include && !single ? listing.files.filter(file => matchesInclude(file, include)) : listing.files;

      // Batches, in listing order, so the output is deterministic while reads still overlap. In
      // content mode the scan stops once the output is full: a broad pattern on a large tree
      // should come back quickly with "narrow it", not after reading every file.
      for (let start = 0; start < candidates.length && !tally.truncated; start += SCAN_BATCH) {
        if (context.signal.aborted) break;
        const batch = candidates.slice(start, start + SCAN_BATCH);
        const scanned = await Promise.all(batch.map(file => scanFile(join(directory, file), expression)));

        for (let index = 0; index < batch.length; index += 1) {
          const result = scanned[index];
          if (!result) continue;
          const keepGoing = tally.add(batch[index], result.hits.length, shown =>
            formatHits(result.lines, result.hits.slice(0, shown), around, expression)
          );
          if (!keepGoing) break;
        }
      }
    }

    const { body, matchingFiles, totalMatches, shownMatches, truncated } = tally;
    const scope = include ? ` in files matching ${include}` : '';
    const timedOut = viaRipgrep === 'timed-out' ? ' The search timed out, so these results are partial.' : '';
    const partial =
      timedOut || (complete ? '' : ` Only the first ${MAX_WALKED_FILES} files under ${base} were searched.`);
    if (matchingFiles === 0) return `${note}No matches for ${expression} under ${base}${scope}.${partial}`;

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
    return capOutput(note + [header + partial, ...body].join('\n'));
  },
};
