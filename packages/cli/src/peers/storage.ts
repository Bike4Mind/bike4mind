import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePeerRoot } from './transport.js';

export class PeerStorage {
  private filePath = '';

  constructor(
    private readonly root: string,
    private readonly incarnation: string
  ) {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(incarnation)) throw new Error('Invalid peer incarnation');
  }

  async init(): Promise<void> {
    const root = await ensurePeerRoot(this.root);
    const directory = await ensurePeerRoot(path.join(root, 'inboxes'));
    this.filePath = path.join(directory, `${this.incarnation}.json`);
    await this.checkFile();
  }

  async history(now: number): Promise<Array<{ storage: PeerStorage; value: unknown }>> {
    const directory = path.dirname(this.filePath);
    const candidates: Array<{ incarnation: string; modifiedAt: number }> = [];
    const files = await fs.readdir(directory);
    if (files.length > 4096) throw new Error('Peer history directory limit reached');
    for (const name of files) {
      if (!/^[a-zA-Z0-9_-]{1,256}\.json$/.test(name) || name === `${this.incarnation}.json`) continue;
      const candidatePath = path.join(directory, name);
      const stat = await fs.lstat(candidatePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        continue;
      if (stat.mtimeMs + 7 * 24 * 60 * 60 * 1000 <= now) await fs.rm(candidatePath);
      else candidates.push({ incarnation: name.slice(0, -5), modifiedAt: stat.mtimeMs });
    }
    const result: Array<{ storage: PeerStorage; value: unknown }> = [];
    for (const candidate of candidates.sort((left, right) => right.modifiedAt - left.modifiedAt).slice(0, 32)) {
      const storage = new PeerStorage(this.root, candidate.incarnation);
      await storage.init();
      const value = await storage.load();
      if (value !== undefined) result.push({ storage, value });
    }
    return result;
  }

  async load(): Promise<unknown | undefined> {
    await this.checkFile();
    let file;
    try {
      file = await fs.open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > 32 * 1024 * 1024 ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.()
      )
        throw new Error('Invalid peer inbox file');
      return JSON.parse(await file.readFile('utf8')) as unknown;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    } finally {
      await file?.close();
    }
  }

  async save(value: unknown): Promise<void> {
    await this.checkFile();
    const contents = JSON.stringify(value);
    if (Buffer.byteLength(contents) > 32 * 1024 * 1024) throw new Error('Peer inbox storage limit reached');
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await fs.open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      await file.writeFile(contents, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
      await fs.rename(temporaryPath, this.filePath);
      const directory = await fs.open(
        path.dirname(this.filePath),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await file?.close();
      await fs.rm(temporaryPath, { force: true });
    }
  }

  private async checkFile(): Promise<void> {
    if (!this.filePath) throw new Error('Peer inbox storage is not initialized');
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
        throw new Error('Unsafe peer inbox file');
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
