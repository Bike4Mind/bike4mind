import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { win32 } from 'node:path';

const PROBE_TIMEOUT_MS = 5_000;

/** What finding Git Bash reads from the machine, so the search can be tested off Windows. */
export interface GitBashProbe {
  env: NodeJS.ProcessEnv;
  exists(path: string): Promise<boolean>;
  /** Stdout of a command, or '' when it fails. */
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

function registryInstallPaths(output: string): string[] {
  return [...output.matchAll(/^\s*InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/gm)].map(match => match[1] as string);
}

/** `<root>\cmd\git.exe`, `<root>\bin\git.exe` and `<root>\mingw64\bin\git.exe` all name the same install. */
function rootsOfGitExe(gitExe: string): string[] {
  const directory = win32.dirname(gitExe);
  return [win32.dirname(directory), win32.dirname(win32.dirname(directory))];
}

async function candidateRoots(probe: GitBashProbe): Promise<string[]> {
  const { env } = probe;
  const [machine, user, where] = await Promise.all([
    probe.run('reg.exe', ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath']),
    probe.run('reg.exe', ['query', 'HKCU\\SOFTWARE\\GitForWindows', '/v', 'InstallPath']),
    probe.run('where.exe', ['git']),
  ]);
  const standard = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]
    .filter((directory): directory is string => Boolean(directory))
    .map(directory => win32.join(directory, 'Git'));
  if (env.LOCALAPPDATA) standard.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  return [
    ...registryInstallPaths(machine),
    ...registryInstallPaths(user),
    ...where
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.toLowerCase().endsWith('git.exe'))
      .flatMap(rootsOfGitExe),
    ...standard,
  ];
}

/** System32\bash.exe is the WSL launcher, which would run the command in Linux instead. */
function inSystemDirectory(path: string, env: NodeJS.ProcessEnv): boolean {
  const systemRoot = win32.resolve(env.SystemRoot || env.windir || 'C:\\Windows').toLowerCase();
  return win32.resolve(path).toLowerCase().startsWith(`${systemRoot}\\`);
}

/** The Git for Windows `bin\bash.exe`, which sets up the MSYS environment its own `usr\bin\bash.exe` lacks. */
export async function findGitBash(probe: GitBashProbe): Promise<string | null> {
  const seen = new Set<string>();
  for (const root of await candidateRoots(probe)) {
    const bash = win32.join(root, 'bin', 'bash.exe');
    const key = bash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (inSystemDirectory(bash, probe.env)) continue;
    if (await probe.exists(bash)) return bash;
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
      execFile(file, [...args], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
        resolve(error ? '' : stdout)
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
