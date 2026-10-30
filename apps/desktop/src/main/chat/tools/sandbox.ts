import { accessSync, constants, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isWithin } from './paths';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const CREDENTIALS = 'It holds credentials.';
const SETTINGS = 'Permission and hook settings can only be changed by you.';
const EXECUTED = 'Claude Code runs what is in it without asking.';
const HISTORY = "Claude Code's session history is read-only.";

/**
 * A path no tool may write, whatever folder the user shared. `~` is expanded at build time.
 *
 * Reads cannot be confined to the granted folders without breaking every real command - `git`
 * alone needs /usr, /bin, the dynamic linker and its own config - so a secret is protected by
 * this deny list instead (`readable: false`). Everything else here is readable and only
 * write-protected: it is what would let a model grant itself permissions or run a command.
 */
interface Guard {
  path: string;
  readable: boolean;
  /** Shown to the model on refusal, so it stops retrying and asks the user. */
  reason: string;
  /** Also covers every sibling whose name starts with this one: the backups and temp copies beside it. */
  prefix?: boolean;
}

const GUARDS: readonly Guard[] = [
  { path: '~/.ssh', readable: false, reason: CREDENTIALS },
  { path: '~/.aws', readable: false, reason: CREDENTIALS },
  { path: '~/.gnupg', readable: false, reason: CREDENTIALS },
  { path: '~/.config/gcloud', readable: false, reason: CREDENTIALS },
  { path: '~/.bike4mind', readable: false, reason: CREDENTIALS },
  { path: '~/Library/Keychains', readable: false, reason: CREDENTIALS },
  { path: '/etc/shadow', readable: false, reason: CREDENTIALS },
  { path: '~/.claude/.credentials.json', readable: false, reason: CREDENTIALS },
  // Account data and MCP server configs, whose `env` holds API keys.
  { path: '~/.claude.json', prefix: true, readable: false, reason: CREDENTIALS },
  { path: '~/.claude/sessions', readable: false, reason: CREDENTIALS },
  { path: '~/.claude/daemon', prefix: true, readable: false, reason: CREDENTIALS },
  // Unreadable as well as unwritable: its `env` is where API keys and exporter auth headers go.
  { path: '~/.claude/settings', prefix: true, readable: false, reason: SETTINGS },
  { path: '~/.claude/remote-settings', prefix: true, readable: true, reason: SETTINGS },
  { path: '~/.claude/policy-limits', prefix: true, readable: true, reason: SETTINGS },
  { path: '/Library/Application Support/ClaudeCode', readable: true, reason: SETTINGS },
  { path: '/etc/claude-code', readable: true, reason: SETTINGS },
  { path: '~/.claude/hooks', readable: true, reason: EXECUTED },
  { path: '~/.claude/plugins', readable: true, reason: EXECUTED },
  { path: '~/.claude/statusline', prefix: true, readable: true, reason: EXECUTED },
  { path: '~/.claude/projects', readable: true, reason: HISTORY },
];

/**
 * Project settings, in any shared repo as well as the user's own: their permission rules and
 * hooks are as much a grant as ~/.claude/settings.json. The two spellings must stay in sync.
 */
const CLAUDE_SETTINGS = /[\\/]\.claude[\\/]settings[^\\/]*$/;
const CLAUDE_SETTINGS_PROFILE = '#"/\\.claude/settings[^/]*$"';

/**
 * Character devices a command must be able to write to.
 *
 * `(deny file-write*)` covers these too, and without them `2>/dev/null` - the single commonest
 * thing in a shell command - fails with "Operation not permitted" on every redirect. Named one
 * by one rather than allowing /dev wholesale, which would also hand over the disk devices.
 */
const WRITABLE_DEVICES = [
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/dtracehelper',
];

export interface SandboxedCommand {
  executable: string;
  args: string[];
  /** Removes the generated profile. Always call it, including on failure. */
  cleanup(): Promise<void>;
}

let expanded: { home: string; guards: readonly Guard[] } | null = null;

/** Expanded once per home folder; tests point HOME somewhere else per run. */
function guards(): readonly Guard[] {
  const home = homedir();
  if (expanded?.home !== home) {
    expanded = { home, guards: GUARDS.map(guard => ({ ...guard, path: expandHome(guard.path) })) };
  }
  return expanded.guards;
}

/** The secret stores, home-expanded: what no tool may read, let alone write. */
export function secretPaths(): string[] {
  return guards()
    .filter(guard => !guard.readable)
    .map(guard => guard.path);
}

/**
 * Why `candidates` may not be read or written, or undefined when nothing protects them.
 *
 * The caller passes every spelling it has of one target - the lexical path and the one with
 * symlinks resolved - and each guard is compared under its own resolved spelling too, so a
 * symlink on either side cannot slip past.
 */
export function protectionFor(candidates: readonly string[], access: 'read' | 'write'): string | undefined {
  // macOS and Windows volumes are case-insensitive by default, and realpath keeps the caller's
  // casing for a name that does not exist yet: `.claude/Settings.local.json` would create the
  // very file Claude Code loads. Folding everywhere only ever refuses more.
  const folded = candidates.map(fold);
  for (const guard of guards()) {
    if (access === 'read' && guard.readable) continue;
    for (const spelling of spellings(guard.path).map(fold)) {
      if (folded.some(candidate => (guard.prefix ? candidate.startsWith(spelling) : isWithin(spelling, candidate)))) {
        return guard.reason;
      }
    }
  }
  if (access === 'write' && folded.some(candidate => CLAUDE_SETTINGS.test(candidate))) return SETTINGS;
  return undefined;
}

function fold(path: string): string {
  return path.toLowerCase();
}

export function sandboxAvailable(): boolean {
  if (platform() !== 'darwin') return false;
  try {
    accessSync(SANDBOX_EXEC, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Seatbelt profiles are S-expressions. Inside a quoted string only the quote and the backslash
 * can end it early, and nothing else can reach the expression parser to inject a directive.
 */
function escapeProfilePath(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function expandHome(value: string): string {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

/**
 * Seatbelt matches the resolved path, so a rule on a symlinked spelling never fires: macOS's
 * tmpdir() is /var/folders/..., which is really /private/var/folders/..., and without the
 * resolved form every tool that writes a temp file (vitest, tsc, npm) fails with EPERM.
 */
function spellings(path: string): string[] {
  const resolved = resolveNearest(path);
  return resolved === path ? [path] : [path, resolved];
}

/** A path that does not exist yet still has to be spelled under its parent's resolved path. */
function resolveNearest(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(resolveNearest(parent), basename(path));
  }
}

/**
 * The profile that confines a shell command.
 *
 * Seatbelt is last-match-wins, so the order is load-bearing: the blanket write denial has to
 * precede the per-root allowances, and the guard denials have to come after ALL of them -
 * otherwise granting the home folder would re-open ~/.ssh for writing.
 *
 * Network is left allowed. Filtering it would need a proxy this client does not run, and
 * denying it outright breaks the ordinary reasons to run a command at all (git, npm, curl).
 * The approval gate, not the sandbox, is what the user is relying on to see egress coming.
 */
export function buildProfile(writableRoots: readonly string[], alwaysDenied: readonly string[]): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    '',
    '(deny file-write*)',
    ...[...writableRoots, tmpdir()]
      .flatMap(spellings)
      .map(root => `(allow file-write* (subpath "${escapeProfilePath(root)}"))`),
    '(allow file-write* (subpath "/tmp"))',
    '(allow file-write* (subpath "/private/tmp"))',
    ...WRITABLE_DEVICES.map(device => `(allow file-write* (literal "${device}"))`),
    '(allow file-write* (subpath "/dev/fd"))',
    '',
  ];

  lines.push(
    `(deny file-write* (regex ${CLAUDE_SETTINGS_PROFILE}))`,
    // A `.claude` symlink, or a project config folder renamed away and back, would carry settings past the
    // regex above, which only ever sees the resolved path.
    '(deny file-write-create (require-all (regex #"/\\.claude$") (vnode-type SYMLINK)))',
    '(deny file-write-unlink (regex #"/\\.claude$"))',
    ...spellings(expandHome('~/.claude')).map(path => `(deny file-write-unlink (literal "${escapeProfilePath(path)}"))`)
  );
  for (const guard of guards()) {
    const operations = guard.readable ? 'file-write*' : 'file-read* file-write*';
    const filter = guard.prefix ? 'prefix' : 'subpath';
    for (const path of spellings(guard.path)) {
      lines.push(`(deny ${operations} (${filter} "${escapeProfilePath(path)}"))`);
    }
  }
  for (const denied of alwaysDenied.flatMap(spellings)) {
    lines.push(`(deny file-read* file-write* (subpath "${escapeProfilePath(denied)}"))`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Wrap `command` so it can write only inside `writableRoots`.
 *
 * `alwaysDenied` is for paths this app must protect regardless of what the user granted - above
 * all its own userData folder, which holds the access token. Without that entry a granted home
 * folder would let a command read the token straight out of the vault, which breaks the
 * rule that the access token never leaves the main process.
 */
export async function sandboxCommand(
  command: string,
  writableRoots: readonly string[],
  alwaysDenied: readonly string[]
): Promise<SandboxedCommand> {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-desktop-sandbox-'));
  const profilePath = join(directory, 'profile.sb');
  await writeFile(profilePath, buildProfile(writableRoots, alwaysDenied), { encoding: 'utf8', mode: 0o600 });

  return {
    executable: SANDBOX_EXEC,
    // The command reaches bash as a single argv entry, never through a shell of our own, so
    // nothing here can be re-split or re-expanded on the way.
    args: ['-f', profilePath, '/bin/bash', '-c', command],
    cleanup: () => rm(directory, { recursive: true, force: true }).catch(() => undefined),
  };
}
