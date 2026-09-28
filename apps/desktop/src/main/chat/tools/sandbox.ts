import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * Paths a sandboxed command may never read, even though reads are otherwise open.
 *
 * Reads cannot be confined to the granted folders without breaking every real command - `git`
 * alone needs /usr, /bin, the dynamic linker and its own config - so the confinement that is
 * worth having is a deny list over the credential stores. `~` is expanded at build time.
 */
const NEVER_READABLE = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gcloud',
  '~/.bike4mind',
  '~/.claude',
  '~/Library/Keychains',
  '/etc/shadow',
];

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

/**
 * The credential stores, home-expanded. Shared with the write tools: a command must not read
 * them, and a write tool must not overwrite them either, whatever folder the user granted.
 */
export function credentialPaths(): string[] {
  return NEVER_READABLE.map(expandHome);
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
 * The profile that confines a shell command.
 *
 * Seatbelt is last-match-wins, so the order is load-bearing: the blanket write denial has to
 * precede the per-root allowances, and the credential denials have to come after ALL of them -
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
    ...writableRoots.map(root => `(allow file-write* (subpath "${escapeProfilePath(root)}"))`),
    `(allow file-write* (subpath "${escapeProfilePath(tmpdir())}"))`,
    '(allow file-write* (subpath "/tmp"))',
    '(allow file-write* (subpath "/private/tmp"))',
    ...WRITABLE_DEVICES.map(device => `(allow file-write* (literal "${device}"))`),
    '(allow file-write* (subpath "/dev/fd"))',
    '',
  ];

  for (const denied of [...credentialPaths(), ...alwaysDenied]) {
    lines.push(`(deny file-read* file-write* (subpath "${escapeProfilePath(denied)}"))`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Wrap `command` so it can write only inside `writableRoots`.
 *
 * `alwaysDenied` is for paths this app must protect regardless of what the user granted - above
 * all its own userData folder, which holds the access token. Without that entry a granted home
 * folder would let a command read the token straight out of the vault, which is the T4
 * invariant broken through the back door.
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
