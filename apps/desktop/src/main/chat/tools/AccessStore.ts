import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * The folders the user has granted the tools. Persisted, because re-granting on every launch
 * would train the user to click through the one prompt that protects the rest of the disk.
 *
 * Grants are added only from a native folder picker the user drives (see src/main/chat/index.ts).
 * Nothing the MODEL sends can widen this set - there is deliberately no "request access" tool.
 */
export class AccessStore {
  private roots: string[] | null = null;

  constructor(private readonly filePath: string) {}

  async list(): Promise<string[]> {
    if (this.roots) return this.roots;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as { roots?: unknown };
      this.roots = Array.isArray(parsed.roots) ? parsed.roots.filter((r): r is string => typeof r === 'string') : [];
    } catch {
      // Missing or corrupt reads as "nothing granted", which fails closed.
      this.roots = [];
    }
    return this.roots;
  }

  async grant(directory: string): Promise<string[]> {
    const absolute = resolve(directory);
    const current = await this.list();
    // A new root that contains an existing one supersedes it, so the list cannot accumulate
    // redundant entries that make the granted surface hard for the user to read.
    const kept = current.filter(root => !isWithin(absolute, root));
    if (!kept.some(root => isWithin(root, absolute))) kept.push(absolute);
    return this.write(kept);
  }

  async revoke(directory: string): Promise<string[]> {
    const current = await this.list();
    return this.write(current.filter(root => root !== directory));
  }

  private async write(roots: string[]): Promise<string[]> {
    this.roots = roots;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ roots }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    return roots;
  }
}

function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}
