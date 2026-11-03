import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { win32 } from 'node:path';

const PROBE_TIMEOUT_MS = 5_000;

/** What finding Git Bash reads from the machine, so the search can be tested off Windows. */
export interface GitBashProbe {
  env: NodeJS.ProcessEnv;
  exists(path: string): Promise<boolean>;
  /** Stdout of an executable named by absolute path, run in the Windows folder; '' when it fails. */
  run(file: string, args: readonly string[]): Promise<string>;
}

export class GitBashMissing extends Error {
  constructor() {
    super(
      'Shell commands on Windows need Git Bash, which comes with Git for Windows ' +
        '(https://git-scm.com/download/win). Install it, then run the command again.'
    );
    this.name = 'GitBashMissing';
  }
}

function systemRoot(env: NodeJS.ProcessEnv): string {
  return win32.resolve(env.SystemRoot || env.windir || 'C:\\Windows');
}

/** A program in the Windows System32 folder, by absolute path. */
export function system32(file: string, env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(systemRoot(env), 'System32', file);
}

function registryInstallPaths(output: string): string[] {
  return [...output.matchAll(/^\s*InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/gm)].map(match => match[1] as string);
}

/** The first `git.exe` on PATH, read from the environment so the path keeps its own characters. */
async function gitOnPath(probe: GitBashProbe): Promise<string | null> {
  for (const entry of (probe.env.Path ?? probe.env.PATH ?? '').split(';')) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!win32.isAbsolute(directory)) continue;
    const gitExe = win32.join(directory, 'git.exe');
    if (await probe.exists(gitExe)) return gitExe;
  }
  return null;
}

/**
 * The install a `git.exe` belongs to, from its exec path (`<root>/<mingw64|clangarm64|...>/libexec/git-core`).
 * Asked of git itself, so a shim such as scoop's leads to the real install.
 */
async function rootOfGitExe(probe: GitBashProbe, gitExe: string): Promise<string | null> {
  const execPath = (await probe.run(gitExe, ['--exec-path'])).trim();
  if (!/[\\/]libexec[\\/]git-core$/i.test(execPath)) return null;
  return win32.dirname(win32.dirname(win32.dirname(win32.normalize(execPath))));
}

/**
 * Install folders in priority order, each looked up only once every earlier one has been tried:
 * the machine registration, the user one, the git on PATH, then the standard folders.
 */
async function* candidateRoots(probe: GitBashProbe): AsyncGenerator<string> {
  const { env } = probe;
  for (const hive of ['HKLM', 'HKCU']) {
    const output = await probe.run(system32('reg.exe', env), [
      'query',
      `${hive}\\SOFTWARE\\GitForWindows`,
      '/v',
      'InstallPath',
    ]);
    yield* registryInstallPaths(output);
  }
  const gitExe = await gitOnPath(probe);
  if (gitExe) {
    // `<root>\cmd\git.exe` or `<root>\bin\git.exe` in a standard install.
    yield win32.dirname(win32.dirname(gitExe));
    const root = await rootOfGitExe(probe, gitExe);
    if (root) yield root;
  }
  for (const directory of [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (directory) yield win32.join(directory, 'Git');
  }
  if (env.LOCALAPPDATA) yield win32.join(env.LOCALAPPDATA, 'Programs', 'Git');
}

/** System32\bash.exe is the WSL launcher, which would run the command in Linux instead. */
function inSystemDirectory(path: string, env: NodeJS.ProcessEnv): boolean {
  return win32
    .resolve(path)
    .toLowerCase()
    .startsWith(`${systemRoot(env).toLowerCase()}\\`);
}

/**
 * The Git for Windows `bin\bash.exe`, which sets up the MSYS environment its own `usr\bin\bash.exe`
 * lacks. A root counts only with the MSYS runtime in it, so another program's `bin\bash.exe` does not.
 */
export async function findGitBash(probe: GitBashProbe): Promise<string | null> {
  const seen = new Set<string>();
  for await (const root of candidateRoots(probe)) {
    if (!win32.isAbsolute(root)) continue;
    const bash = win32.join(root, 'bin', 'bash.exe');
    const key = bash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (inSystemDirectory(bash, probe.env)) continue;
    const [shell, runtime] = await Promise.all([
      probe.exists(bash),
      probe.exists(win32.join(root, 'usr', 'bin', 'msys-2.0.dll')),
    ]);
    if (shell && runtime) return bash;
  }
  return null;
}

const machineProbe: GitBashProbe = {
  env: process.env,
  exists: path =>
    access(path, constants.F_OK).then(
      () => true,
      () => false
    ),
  run: (file, args) =>
    new Promise(resolve => {
      // A fixed cwd: Windows looks beside the working directory before PATH for DLLs and helpers.
      execFile(
        file,
        [...args],
        { cwd: systemRoot(process.env), timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => resolve(error ? '' : stdout)
      );
    }),
};

let found: Promise<string> | undefined;

/**
 * Cached once found and while it still exists; a miss is not, so installing, moving or removing
 * Git takes effect without a restart.
 */
export async function resolveGitBash(probe: GitBashProbe = machineProbe): Promise<string> {
  const cached = await found?.catch(() => undefined);
  if (cached && (await probe.exists(cached))) return cached;
  found = findGitBash(probe).then(bash => {
    if (bash) return bash;
    found = undefined;
    throw new GitBashMissing();
  });
  return found;
}
