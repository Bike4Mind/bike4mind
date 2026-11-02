import { readFile, realpath as nodeRealpath, statfs as nodeStatfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import type { STORE_PATH_SOURCES } from '@bike4mind/common/modelHub';
import type { StatfsResult } from './hardware';
import type { SystemdUnit } from './ollamaInstall';
import { ollamaEnvValue, type OllamaEnvironment } from './ollamaSettings';

export type StorePathSource = (typeof STORE_PATH_SOURCES)[number];

export interface MountEntry {
  mountPoint: string;
  fsType: string;
}

const unescapeMount = (field: string) =>
  field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

/** Mount points from `/proc/self/mountinfo`, whose fifth field is the mount point and whose type follows ` - `. */
export function parseMountinfo(text: string): MountEntry[] {
  return text.split('\n').flatMap((line): MountEntry[] => {
    const [before, after] = line.split(' - ');
    const fields = before?.split(' ') ?? [];
    if (fields.length < 5 || after === undefined) return [];
    return [{ mountPoint: unescapeMount(fields[4]), fsType: after.split(' ')[0] ?? '' }];
  });
}

/** The mount holding `path`: the longest mount point that is `path` or one of its parents. */
export function mountFor(path: string, mounts: MountEntry[]): MountEntry | null {
  const normalized = posix.normalize(path);
  let best: MountEntry | null = null;
  for (const mount of mounts) {
    const point = mount.mountPoint;
    const contains = point === '/' || normalized === point || normalized.startsWith(`${point}/`);
    if (contains && (!best || point.length >= best.mountPoint.length)) best = mount;
  }
  return best;
}

/** A user's home directory from `/etc/passwd` text. */
export function passwdHome(text: string, user: string): string | null {
  for (const line of text.split('\n')) {
    const fields = line.split(':');
    if (fields.length >= 7 && fields[0] === user) return fields[5] || null;
  }
  return null;
}

export interface StorePathInput {
  env: OllamaEnvironment;
  unit: SystemdUnit | null;
  /** Reads `contents.storeDir` from an installed model; the last resort. */
  installedStoreDir?: () => Promise<string | null>;
  rootDir?: string;
  /** This user's home, for a `systemctl --user` Ollama. */
  homeDir?: string;
}

const MODELS_SUBDIR = join('.ollama', 'models');

/**
 * The home Ollama runs with: its HOME (the process's, or a unit's `Environment=HOME=`), else the unit user's home
 * from `/etc/passwd`, or this user's for a `systemctl --user` unit.
 */
export async function serviceHome(input: Omit<StorePathInput, 'installedStoreDir'>): Promise<string | null> {
  const home = ollamaEnvValue(input.env, 'HOME');
  const { unit } = input;
  if (home || !unit) return home || null;
  if (unit.scope === 'user') return input.homeDir ?? homedir();
  const passwd = await readFile(join(input.rootDir ?? '/', 'etc/passwd'), 'utf8').catch(() => null);
  return passwd === null ? null : passwdHome(passwd, unit.user ?? 'root');
}

/** Where Ollama keeps models: OLLAMA_MODELS, else its user's `~/.ollama/models`, else an installed model's folder. */
export async function resolveStorePath(
  input: StorePathInput
): Promise<{ path: string | null; source: StorePathSource | null }> {
  const configured = ollamaEnvValue(input.env, 'OLLAMA_MODELS');
  if (configured) return { path: configured, source: 'setting' };
  const home = await serviceHome(input);
  if (home) return { path: join(home, MODELS_SUBDIR), source: input.unit ? 'service-home' : 'process-home' };
  const installed = await input.installedStoreDir?.().catch(() => null);
  return installed ? { path: installed, source: 'installed-model' } : { path: null, source: null };
}

export interface StoreDiskOptions {
  rootDir?: string;
  statfs?: (path: string) => Promise<StatfsResult>;
  realpath?: (path: string) => Promise<string>;
}

export interface StoreDisk {
  mountPoint: string | null;
  freeBytes: number | null;
  /** False when the path could not be resolved through its symlinks (often a home closed to this user). */
  resolved: boolean;
}

/**
 * Free space on the store's filesystem, measured at its mount point: the service user's home can be closed to
 * others (Ubuntu's HOME_MODE 0750 on /usr/share/ollama) while the mount point stays reachable.
 */
export async function storeDisk(path: string, options: StoreDiskOptions = {}): Promise<StoreDisk> {
  const statfs = options.statfs ?? nodeStatfs;
  const real = await (options.realpath ?? nodeRealpath)(path).catch(() => null);
  const target = real ?? path;
  const resolved = real !== null;
  const mountinfo = await readFile(join(options.rootDir ?? '/', 'proc/self/mountinfo'), 'utf8').catch(() => null);
  const mountPoint = mountinfo === null ? null : (mountFor(target, parseMountinfo(mountinfo))?.mountPoint ?? null);
  for (const measured of mountPoint ? [mountPoint, target] : [target]) {
    try {
      const stats = await statfs(measured);
      return { mountPoint, freeBytes: Number(stats.bavail) * Number(stats.bsize), resolved };
    } catch {
      // Try the store itself when the mount point cannot be measured.
    }
  }
  return { mountPoint, freeBytes: null, resolved };
}
