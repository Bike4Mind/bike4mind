import { spawn } from 'node:child_process';
import { wslCommand, wslCommandEnv, wslLocation } from '../../wsl/wslPath';

const LIST_TIMEOUT_MS = 30_000;

export interface DistroFile {
  /** Relative to the folder, with forward slashes. */
  path: string;
  size: number;
  /** Milliseconds since the epoch. */
  modified: number;
}

export interface DistroListing {
  files: DistroFile[];
  /** False when the list stopped at the limit or the time allowed. */
  complete: boolean;
}

/**
 * The regular files under a WSL folder, listed by the distro's own `find` so the share is never
 * walked from Windows, with size and modification time in the same pass. Like the caller's own walk,
 * it does not enter directories named in `ignored` or hidden ones, and leaves hidden files out. Null
 * when the distro cannot run `find` or the folder is not in one, and the caller lists it itself.
 */
export async function listDistroFiles(
  directory: string,
  ignored: ReadonlySet<string>,
  limit: number,
  signal: AbortSignal,
  platform?: NodeJS.Platform
): Promise<DistroListing | null> {
  const wsl = wslLocation(directory, platform);
  if (!wsl) return null;
  const skipped = [...ignored, '.?*'].flatMap((name, index) => (index === 0 ? ['-name', name] : ['-o', '-name', name]));
  const args = [
    '.',
    '(',
    '-type',
    'd',
    '(',
    ...skipped,
    ')',
    '-prune',
    ')',
    '-o',
    '-type',
    'f',
    '!',
    '-name',
    '.*',
    '-printf',
    '%s %T@ %p\\0',
  ];
  const command = wslCommand(wsl, 'find', args);
  const env = await wslCommandEnv(process.env, wsl.distro);

  return new Promise(resolve => {
    const child = spawn(command.file, command.args, {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const files: DistroFile[] = [];
    let pending = '';
    let complete = true;
    let settled = false;

    const finish = (result: DistroListing | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve(result);
    };
    const stop = () => {
      complete = false;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, LIST_TIMEOUT_MS);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });

    const take = (record: string): boolean => {
      const [size, modified, ...rest] = record.split(' ');
      const path = rest.join(' ').replace(/^\.\//, '');
      if (!path || !/^\d+$/.test(size ?? '')) return true;
      if (files.length >= limit) {
        complete = false;
        return false;
      }
      files.push({ path, size: Number(size), modified: Math.round(Number(modified) * 1000) });
      return true;
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let end = pending.indexOf('\0');
      while (end !== -1) {
        const record = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!take(record)) return stop();
        end = pending.indexOf('\0');
      }
    });
    child.on('error', () => finish(null));
    child.on('close', code => {
      // 125 is the folder missing, 127 a distro without find; find itself exits 1 for a folder it could not read.
      if (code === 125 || code === 127 || (code !== 0 && files.length === 0 && complete)) return finish(null);
      finish({ files, complete });
    });
  });
}
