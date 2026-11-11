import { createHash } from 'node:crypto';
import type { ExportedNotebook, NotebookExportFormat } from './types';

export const BUNDLE_EXPORT_VERSION = '2.0.0';

export interface BundleEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BundleCollection extends BundleEntry {
  count: number;
}

export interface ExportBundleManifest {
  exportVersion: typeof BUNDLE_EXPORT_VERSION;
  exportedAt: string;
  platform: string;
  exportedBy?: string;
  collections: Record<string, BundleCollection>;
  files: BundleEntry[];
}

export type BundleWrite = (path: string, bytes: Uint8Array) => Promise<void>;
export type BundleAppend = (path: string, bytes: Uint8Array) => Promise<void>;
export type BundleRead = (path: string) => Promise<Uint8Array>;

export interface BundleFile {
  path: string;
  content: Uint8Array;
}

export interface BundleInput {
  collections: Record<string, Iterable<unknown> | AsyncIterable<unknown>>;
  files?: Iterable<BundleFile> | AsyncIterable<BundleFile>;
  exportedAt?: string;
  exportedBy?: string;
  platform?: string;
}

export interface NotebookBundleOptions extends Pick<BundleInput, 'exportedAt' | 'exportedBy' | 'platform'> {
  imagesAsKeys?: boolean;
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validPath = (value: string) =>
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');

const rowsOf = async function* (source: Iterable<unknown> | AsyncIterable<unknown>): AsyncGenerator<unknown> {
  for await (const row of source) yield row;
};

export async function createExportBundle(
  input: BundleInput,
  write: BundleWrite,
  append?: BundleAppend
): Promise<ExportBundleManifest> {
  const manifest: ExportBundleManifest = {
    exportVersion: BUNDLE_EXPORT_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    platform: input.platform ?? 'bike4mind',
    ...(input.exportedBy ? { exportedBy: input.exportedBy } : {}),
    collections: {},
    files: [],
  };
  const seen = new Set<string>();
  for (const [name, source] of Object.entries(input.collections)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid collection name: ${name}`);
    const path = `collections/${name}.jsonl`;
    const lines: string[] = [];
    const hash = createHash('sha256');
    let count = 0;
    let byteCount = 0;
    if (append) await write(path, Buffer.alloc(0));
    for await (const row of rowsOf(source)) {
      const encoded = JSON.stringify(row);
      if (encoded === undefined) throw new Error(`Invalid record in ${name}`);
      if (append) {
        const bytes = Buffer.from(`${encoded}\n`, 'utf8');
        await append(path, bytes);
        hash.update(bytes);
        byteCount += bytes.length;
      } else {
        lines.push(encoded);
      }
      count++;
    }
    if (!append) {
      const bytes = Buffer.from(lines.map(line => `${line}\n`).join(''), 'utf8');
      await write(path, bytes);
      hash.update(bytes);
      byteCount = bytes.length;
    }
    manifest.collections[name] = { path, count, bytes: byteCount, sha256: hash.digest('hex') };
    seen.add(path);
  }
  if (input.files) {
    for await (const file of input.files) {
      if (!validPath(file.path) || !file.path.startsWith('files/')) throw new Error(`Invalid file path: ${file.path}`);
      if (seen.has(file.path)) throw new Error(`Duplicate bundle path: ${file.path}`);
      seen.add(file.path);
      const bytes = Buffer.from(file.content);
      await write(file.path, bytes);
      manifest.files.push({ path: file.path, bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  await write('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));
  return manifest;
}

function isEntry(value: unknown): value is BundleEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<BundleEntry>;
  return (
    typeof entry.path === 'string' &&
    validPath(entry.path) &&
    Number.isSafeInteger(entry.bytes) &&
    entry.bytes! >= 0 &&
    typeof entry.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.sha256)
  );
}

export async function readExportBundle(read: BundleRead): Promise<{
  manifest: ExportBundleManifest;
  collections: Record<string, unknown[]>;
  files: Map<string, Uint8Array>;
}> {
  const manifest = JSON.parse(Buffer.from(await read('manifest.json')).toString('utf8')) as ExportBundleManifest;
  if (
    manifest.exportVersion !== BUNDLE_EXPORT_VERSION ||
    !Number.isFinite(Date.parse(manifest.exportedAt)) ||
    typeof manifest.platform !== 'string' ||
    !manifest.platform ||
    !manifest.collections ||
    typeof manifest.collections !== 'object' ||
    Array.isArray(manifest.collections) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('Invalid bundle manifest');
  }
  const seen = new Set<string>();
  const checked = async (entry: BundleEntry, expectedPath?: string): Promise<Buffer> => {
    if (!isEntry(entry) || (expectedPath && entry.path !== expectedPath) || seen.has(entry.path)) {
      throw new Error(`Invalid or duplicate bundle entry: ${entry?.path}`);
    }
    seen.add(entry.path);
    const bytes = Buffer.from(await read(entry.path));
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) {
      throw new Error(`Bundle checksum mismatch: ${entry.path}`);
    }
    return bytes;
  };
  const collections: Record<string, unknown[]> = {};
  const files = new Map<string, Uint8Array>();
  for (const [name, entry] of Object.entries(manifest.collections)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !Number.isSafeInteger(entry?.count) || entry.count < 0) {
      throw new Error(`Invalid collection: ${name}`);
    }
    const bytes = await checked(entry, `collections/${name}.jsonl`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text && !text.endsWith('\n')) throw new Error(`Incomplete JSONL: ${name}`);
    const rows = text
      ? text
          .slice(0, -1)
          .split('\n')
          .map(line => JSON.parse(line) as unknown)
      : [];
    if (rows.length !== entry.count) throw new Error(`Collection count mismatch: ${name}`);
    collections[name] = rows;
  }
  for (const file of manifest.files) {
    if (!isEntry(file) || !file.path.startsWith('files/')) throw new Error('Invalid external file entry');
    files.set(file.path, await checked(file));
  }
  return { manifest, collections, files };
}

type NotebookCollections = 'notebooks' | 'chat-messages' | 'knowledge' | 'artifacts' | 'tools' | 'agents';
const childCollections = ['chat-messages', 'knowledge', 'artifacts', 'tools', 'agents'] as const;
const notebookKeys = ['chatHistory', 'knowledge', 'artifacts', 'tools', 'agents'] as const;

export async function createNotebookBundle(
  notebooks: Iterable<ExportedNotebook> | AsyncIterable<ExportedNotebook>,
  write: BundleWrite,
  metadata: NotebookBundleOptions = {}
): Promise<ExportBundleManifest> {
  const collections: Record<NotebookCollections, unknown[]> = {
    notebooks: [],
    'chat-messages': [],
    knowledge: [],
    artifacts: [],
    tools: [],
    agents: [],
  };
  const files: BundleFile[] = [];
  const filePaths = new Set<string>();
  for await (const notebook of rowsOf(notebooks) as AsyncGenerator<ExportedNotebook>) {
    const { chatHistory, knowledge, artifacts, tools, agents, ...record } = notebook;
    collections.notebooks.push(record);
    const children = [chatHistory, knowledge, artifacts, tools, agents];
    childCollections.forEach((name, index) => {
      for (const child of children[index]) {
        const row = { ...child, notebookId: notebook.id } as Record<string, unknown>;
        if (name === 'knowledge' && typeof row.content === 'string') {
          const bytes = Buffer.from(row.content, 'base64');
          const path = `files/${digest(bytes)}`;
          if (!filePaths.has(path)) {
            files.push({ path, content: bytes });
            filePaths.add(path);
          }
          delete row.content;
          row.contentPath = path;
        }
        if (name === 'chat-messages' && Array.isArray(row.images) && !metadata.imagesAsKeys) {
          row.images = row.images.map(image => {
            if (
              typeof image !== 'string' ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image)
            ) {
              return image;
            }
            const bytes = Buffer.from(image, 'base64');
            const path = `files/${digest(bytes)}`;
            if (!filePaths.has(path)) {
              files.push({ path, content: bytes });
              filePaths.add(path);
            }
            return { contentPath: path };
          });
        }
        collections[name].push(row);
      }
    });
  }
  const { imagesAsKeys: _imagesAsKeys, ...bundleMetadata } = metadata;
  return createExportBundle({ collections, files, ...bundleMetadata }, write);
}

export async function readNotebookBundle(read: BundleRead): Promise<NotebookExportFormat> {
  const { manifest, collections, files } = await readExportBundle(read);
  if (!Array.isArray(collections.notebooks) || childCollections.some(name => !Array.isArray(collections[name]))) {
    throw new Error('Missing notebook collection');
  }
  const notebooks = collections.notebooks.map(row => {
    if (!row || typeof row !== 'object' || typeof (row as ExportedNotebook).id !== 'string') {
      throw new Error('Invalid notebook record');
    }
    return {
      ...(row as Record<string, unknown>),
      chatHistory: [],
      knowledge: [],
      artifacts: [],
      tools: [],
      agents: [],
    } as unknown as ExportedNotebook;
  });
  const byId = new Map<string, ExportedNotebook>();
  for (const notebook of notebooks) {
    if (byId.has(notebook.id)) throw new Error(`Duplicate notebook: ${notebook.id}`);
    byId.set(notebook.id, notebook);
  }
  for (const [index, name] of childCollections.entries()) {
    const key = notebookKeys[index];
    for (const value of collections[name]) {
      if (!value || typeof value !== 'object') throw new Error(`Invalid ${name} record`);
      const { notebookId, ...record } = value as Record<string, unknown>;
      const notebook = byId.get(String(notebookId));
      if (!notebook) throw new Error(`Unknown notebook in ${name}`);
      if (name === 'knowledge' && record.contentPath !== undefined) {
        const path = record.contentPath;
        const bytes = typeof path === 'string' ? files.get(path) : undefined;
        if (!bytes) {
          throw new Error('Missing knowledge file');
        }
        record.content = Buffer.from(bytes).toString('base64');
        delete record.contentPath;
      }
      if (name === 'chat-messages' && Array.isArray(record.images)) {
        record.images = record.images.map(image => {
          if (!image || typeof image !== 'object' || !('contentPath' in image)) return image;
          const path = (image as { contentPath: unknown }).contentPath;
          const bytes = typeof path === 'string' ? files.get(path) : undefined;
          if (!bytes) throw new Error('Missing image file');
          return Buffer.from(bytes).toString('base64');
        });
      }
      (notebook[key] as unknown[]).push(record);
    }
  }
  return {
    exportVersion: BUNDLE_EXPORT_VERSION,
    exportedAt: manifest.exportedAt,
    exportedBy: manifest.exportedBy,
    platform: manifest.platform,
    notebooks,
  };
}
