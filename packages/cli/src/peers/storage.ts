import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePeerRoot } from './transport.js';
import { isPeerIdentity } from './protocol.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_SCAN = 16_384;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

export function hasLivePeerWriter(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('writer' in value) || !value.writer || typeof value.writer !== 'object')
    return false;
  const writer = value.writer as Record<string, unknown>;
  if (!Number.isSafeInteger(writer.processId) || Number(writer.processId) < 1) return false;
  try {
    process.kill(Number(writer.processId), 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

export function hasActivePeerWriter(value: unknown): boolean {
  if (
    !hasLivePeerWriter(value) ||
    !value ||
    typeof value !== 'object' ||
    !('writer' in value) ||
    !value.writer ||
    typeof value.writer !== 'object'
  )
    return false;
  return (
    ('activeMessageId' in value.writer && typeof value.writer.activeMessageId === 'string') ||
    ('activeRequests' in value.writer &&
      typeof value.writer.activeRequests === 'number' &&
      value.writer.activeRequests > 0)
  );
}

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
    const candidates: Array<{ storage: PeerStorage; value: unknown; modifiedAt: number }> = [];
    let scanned = 0;
    let bytes = 0;
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      if (++scanned > MAX_HISTORY_SCAN) break;
      const name = entry.name;
      if (name === `${this.incarnation}.json`) continue;
      const snapshot = /^[a-zA-Z0-9_-]{1,256}\.json$/.test(name);
      const temporary = /^[a-zA-Z0-9_-]{1,256}\.json\.[a-f0-9-]{36}\.tmp$/.test(name);
      if (!snapshot && !temporary) continue;
      const candidatePath = path.join(directory, name);
      try {
        const stat = await fs.lstat(candidatePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
          continue;
        if (temporary) {
          if (stat.mtimeMs + RETENTION_MS <= now) await fs.rm(candidatePath);
          continue;
        }
        if (stat.size > 32 * 1024 * 1024 || bytes + stat.size > MAX_HISTORY_BYTES) continue;
        bytes += stat.size;
        const storage = new PeerStorage(this.root, name.slice(0, -5));
        await storage.init();
        const value = await storage.load();
        if (!isManagedSnapshot(value)) continue;
        if (stat.mtimeMs + RETENTION_MS <= now && !hasActivePeerWriter(value)) {
          await fs.rm(candidatePath);
          continue;
        }
        candidates.push({ storage, value, modifiedAt: stat.mtimeMs });
        candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
        if (candidates.length > 32) candidates.pop();
      } catch (error) {
        if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
      }
    }
    return candidates.map(({ storage, value }) => ({ storage, value }));
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

function isManagedSnapshot(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'version' in value &&
    value.version === 1 &&
    'identity' in value &&
    isPeerIdentity(value.identity) &&
    'incoming' in value &&
    Array.isArray(value.incoming) &&
    'outgoing' in value &&
    Array.isArray(value.outgoing)
  );
}
