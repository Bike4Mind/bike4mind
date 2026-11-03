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

function system32(env: NodeJS.ProcessEnv, file: string): string {
  return win32.join(systemRoot(env), 'System32', file);
}

function registryInstallPaths(output: string): string[] {
  return [...output.matchAll(/^\s*InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/gm)].map(match => match[1] as string);
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

async function candidateRoots(probe: GitBashProbe): Promise<string[]> {
  const { env } = probe;
  const reg = system32(env, 'reg.exe');
  const [machine, user, where] = await Promise.all([
    probe.run(reg, ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath']),
    probe.run(reg, ['query', 'HKCU\\SOFTWARE\\GitForWindows', '/v', 'InstallPath']),
    probe.run(system32(env, 'where.exe'), ['git']),
  ]);
  const onPath = await Promise.all(
    where
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => win32.isAbsolute(line) && line.toLowerCase().endsWith('git.exe'))
      .map(gitExe => rootOfGitExe(probe, gitExe))
  );
  const standard = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]
    .filter((directory): directory is string => Boolean(directory))
    .map(directory => win32.join(directory, 'Git'));
  if (env.LOCALAPPDATA) standard.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  return [
    ...registryInstallPaths(machine),
    ...registryInstallPaths(user),
    ...onPath.filter((root): root is string => root !== null),
    ...standard,
  ];
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
  for (const root of await candidateRoots(probe)) {
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

/** Cached once found; a miss is not, so installing Git takes effect without a restart. */
export function resolveGitBash(): Promise<string> {
  found ??= findGitBash(machineProbe).then(bash => {
    if (bash) return bash;
    found = undefined;
    throw new GitBashMissing();
  });
  return found;
}
