import { glob, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveWithinRoots } from './paths';
import { capOutput, optionalNumber, requireString, type ToolContext, type ToolDefinition } from './types';

/** Directories never worth walking; they dominate results and blow the output cap. */
const IGNORED = new Set(['node_modules', '.git', '.next', 'dist', 'out', '.turbo', '.cache', 'Library']);

const MAX_MATCHES = 300;

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

/** Where a relative pattern is anchored: the single granted root, when there is exactly one. */
function defaultBase(context: ToolContext): string {
  if (context.roots.length === 1) return context.roots[0];
  throw new Error(
    `Specify "path": several folders are granted (${context.roots.join(', ')}), so a relative pattern is ambiguous.`
  );
}

async function walk(
  base: string,
  context: ToolContext,
  onFile: (absolute: string) => Promise<void> | void
): Promise<void> {
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
        await onFile(absolute);
      }
    }
  }
}

export const fileRead: ToolDefinition = {
  schema: {
    name: 'file_read',
    description:
      'Read a text file from the local filesystem. Only files inside folders the user has ' +
      'granted are readable. Use offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
        offset: { type: 'number', description: 'First line to return (1-based).' },
        limit: { type: 'number', description: 'Maximum number of lines to return.' },
      },
      required: ['path'],
    },
  },
  async run(input, context) {
    const target = await resolveWithinRoots(requireString(input, 'path'), context.roots);
    const info = await stat(target);
    if (info.isDirectory()) throw new Error(`${target} is a directory. Use glob_files to list it.`);

    const contents = await readFile(target, 'utf8');
    const offset = optionalNumber(input, 'offset');
    const limit = optionalNumber(input, 'limit');
    if (offset === undefined && limit === undefined) return capOutput(contents);

    const lines = contents.split('\n');
    const from = Math.max(0, (offset ?? 1) - 1);
    return capOutput(lines.slice(from, limit === undefined ? undefined : from + limit).join('\n'));
  },
};

export const globFiles: ToolDefinition = {
  schema: {
    name: 'glob_files',
    description:
      'List files matching a glob pattern, newest-modified first, with their sizes. Use this ' +
      'to explore a folder or to find the largest or most recent files in it.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob such as "**/*.ts" or "*". Defaults to "*".' },
        path: { type: 'string', description: 'Absolute folder to search in.' },
        sort: { type: 'string', description: '"size" or "modified" (default).' },
      },
      required: [],
    },
  },
  async run(input, context) {
    const requested = typeof input.path === 'string' && input.path ? input.path : defaultBase(context);
    const base = await resolveWithinRoots(requested, context.roots);
    const pattern = typeof input.pattern === 'string' && input.pattern ? input.pattern : '*';

    const found: { path: string; size: number; modified: number }[] = [];
    for await (const match of glob(pattern, { cwd: base })) {
      if (context.signal.aborted) break;
      const absolute = join(base, match);
      try {
        const info = await stat(absolute);
        if (info.isFile()) found.push({ path: absolute, size: info.size, modified: info.mtimeMs });
      } catch {
        // A file that vanished between listing and stat is simply not reported.
      }
      if (found.length >= MAX_MATCHES * 4) break;
    }

    if (found.length === 0) return `No files matched ${pattern} in ${base}.`;

    const bySize = input.sort === 'size';
    found.sort((a, b) => (bySize ? b.size - a.size : b.modified - a.modified));

    const rows = found
      .slice(0, MAX_MATCHES)
      .map(
        entry =>
          `${formatBytes(entry.size).padStart(10)}  ${new Date(entry.modified).toISOString().slice(0, 10)}  ${relative(base, entry.path) || entry.path}`
      );
    const header = `${found.length} file(s) in ${base}, sorted by ${bySize ? 'size' : 'modification time'}:`;
    return capOutput([header, ...rows].join('\n'));
  },
};

export const grepSearch: ToolDefinition = {
  schema: {
    name: 'grep_search',
    description: 'Search file contents with a regular expression, returning matching lines with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Absolute folder to search in.' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive match.' },
      },
      required: ['pattern'],
    },
  },
  async run(input, context) {
    const requested = typeof input.path === 'string' && input.path ? input.path : defaultBase(context);
    const base = await resolveWithinRoots(requested, context.roots);

    let expression: RegExp;
    try {
      expression = new RegExp(requireString(input, 'pattern'), input.ignoreCase === true ? 'i' : undefined);
    } catch (err) {
      throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
    }

    const matches: string[] = [];
    await walk(base, context, async absolute => {
      if (matches.length >= MAX_MATCHES) return;
      let contents: string;
      try {
        contents = await readFile(absolute, 'utf8');
      } catch {
        return; // Binary or unreadable: not an error, just not searchable.
      }
      contents.split('\n').forEach((line, index) => {
        if (matches.length >= MAX_MATCHES || !expression.test(line)) return;
        matches.push(`${relative(base, absolute)}:${index + 1}: ${line.trim().slice(0, 200)}`);
      });
    });

    if (matches.length === 0) return `No matches for ${expression} under ${base}.`;
    return capOutput(matches.join('\n'));
  },
};
