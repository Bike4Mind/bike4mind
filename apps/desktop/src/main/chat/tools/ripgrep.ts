import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveUserPath } from './userPath';

export interface RipgrepLine {
  number: number;
  text: string;
  match: boolean;
}

/** One file's hits with their context, in file order. Only files with a match are reported. */
export interface RipgrepFile {
  path: string;
  lines: RipgrepLine[];
  matches: number;
}

export interface RipgrepSearch {
  pattern: string;
  cwd: string;
  ignoreCase: boolean;
  context: number;
  exclude: readonly string[];
  maxFileBytes: number;
  signal: AbortSignal;
  /** Called once per matching file, in path order. Returning false stops the search. */
  onFile(file: RipgrepFile): boolean;
}

/**
 * `unavailable` and `unsupported` mean nothing was searched and the caller should use its own
 * engine: there is no `rg` on the user's PATH, or the pattern is JavaScript syntax the Rust
 * regex engine rejects (lookaround, backreferences).
 */
export type RipgrepOutcome = 'done' | 'stopped' | 'timed-out' | 'unavailable' | 'unsupported';

const SEARCH_TIMEOUT_MS = 30_000;
/** A missing rg is re-checked now and then, so installing one does not need an app restart. */
const UNAVAILABLE_RETRY_MS = 5 * 60_000;
const STDERR_KEPT_CHARS = 4_000;
const REGEX_REJECTED = /regex parse error|error parsing regex|look-around|backreference|unsupported/i;

interface RipgrepText {
  text?: string;
  bytes?: string;
}

interface RipgrepRecord {
  type?: string;
  data?: { path?: RipgrepText; lines?: RipgrepText; line_number?: number };
}

let unavailableUntil = 0;

/** git lists dotfiles and rg skips them by default, so --hidden is only right inside a work tree. */
function insideGitWorkTree(directory: string): boolean {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    if (dirname(current) === current) return false;
  }
}

function decode(field: RipgrepText | undefined): string {
  if (!field) return '';
  return field.text ?? (field.bytes ? Buffer.from(field.bytes, 'base64').toString('utf8') : '');
}

export async function ripgrepSearch(search: RipgrepSearch): Promise<RipgrepOutcome> {
  if (process.env.B4M_DISABLE_RIPGREP === '1' || Date.now() < unavailableUntil) return 'unavailable';

  const args = [
    '--json',
    '--no-config',
    '--no-messages',
    '--sort',
    'path',
    '--max-filesize',
    String(search.maxFileBytes),
    '--regexp',
    search.pattern,
  ];
  if (search.ignoreCase) args.push('--ignore-case');
  if (search.context > 0) args.push('--context', String(search.context));
  const inWorkTree = insideGitWorkTree(search.cwd);
  if (inWorkTree) args.push('--hidden');
  // Inside a work tree .gitignore decides, as it does for the file listing; outside one nothing does.
  for (const glob of inWorkTree ? ['.git'] : [...search.exclude, '.git']) args.push('--glob', `!${glob}`);
  // An explicit "." rather than none: with no path rg may read stdin instead of searching cwd.
  args.push('--', '.');

  const env = { ...process.env, PATH: await resolveUserPath() };

  return new Promise<RipgrepOutcome>(resolve => {
    const child = spawn('rg', args, { cwd: search.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let stopped = false;
    let stderr = '';

    const kill = () => child.kill('SIGKILL');
    let timedOut = false;
    let reported = 0;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, SEARCH_TIMEOUT_MS);
    const finish = (outcome: RipgrepOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      search.signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => {
      stopped = true;
      kill();
    };
    if (search.signal.aborted) onAbort();
    else search.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') unavailableUntil = Date.now() + UNAVAILABLE_RETRY_MS;
      finish('unavailable');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_KEPT_CHARS) stderr += chunk.toString('utf8');
    });

    let current: RipgrepFile | undefined;
    createInterface({ input: child.stdout }).on('line', raw => {
      if (stopped) return;
      let record: RipgrepRecord;
      try {
        record = JSON.parse(raw);
      } catch {
        return;
      }
      const { data } = record;

      if (record.type === 'begin') {
        current = { path: decode(data?.path).replace(/^\.\//, ''), lines: [], matches: 0 };
      } else if ((record.type === 'match' || record.type === 'context') && current && data?.line_number) {
        const isMatch = record.type === 'match';
        current.lines.push({
          number: data.line_number,
          text: decode(data.lines).replace(/\r?\n$/, ''),
          match: isMatch,
        });
        if (isMatch) current.matches += 1;
      } else if (record.type === 'end' && current) {
        const file = current;
        current = undefined;
        reported += 1;
        if (!search.onFile(file)) {
          stopped = true;
          kill();
        }
      }
    });

    child.on('close', code => {
      if (stopped) return finish('stopped');
      if (timedOut) return finish('timed-out');
      // Exit 2 is "an error occurred". With nothing found it cannot be told from "no match", so
      // the caller searches again itself rather than report a clean miss: a size-limited or
      // otherwise rejected pattern would look exactly like that.
      if (code === 2 && (reported === 0 || REGEX_REJECTED.test(stderr))) return finish('unsupported');
      finish('done');
    });
  });
}
