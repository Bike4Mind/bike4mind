import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, type Dirent, type WriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ChatSession } from '@shared/chat';
import { isValidSessionId } from './SessionStore';
import { defaultUserInstructionsRoot } from './project/instructions';
import { memoryStoreFor } from './project/memory';
import type { AttachmentStore } from './AttachmentStore';
import type { MediaStore } from './media/MediaStore';

export interface LocalDataExportDeps {
  sessions: {
    list(): Promise<{ id: string }[]>;
    get(id: string): Promise<ChatSession | null>;
    scopeKey(): string | null;
  };
  attachments: Pick<AttachmentStore, 'locate'>;
  media: Pick<MediaStore, 'locate' | 'directoryFor'>;
  userData: string;
  memoryRoot?: string;
}

type Collection =
  | 'notebooks'
  | 'chat-messages'
  | 'knowledge'
  | 'artifacts'
  | 'tools'
  | 'agents'
  | 'desktop-sessions'
  | 'memory'
  | 'media';
type Row = Record<string, unknown>;

interface RowWriter {
  stream: WriteStream;
  hash: ReturnType<typeof createHash>;
  bytes: number;
  count: number;
}
const COLLECTIONS: readonly Collection[] = [
  'notebooks',
  'chat-messages',
  'knowledge',
  'artifacts',
  'tools',
  'agents',
  'desktop-sessions',
  'memory',
  'media',
];

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function assertDestination(folder: string, userData: string): Promise<void> {
  if (!isAbsolute(folder)) throw new Error('Choose an absolute export folder.');
  const [realFolder, realUserData] = await Promise.all([realpath(folder), realpath(userData)]);
  if (inside(realUserData, realFolder)) {
    throw new Error('Choose a folder outside the app data directory.');
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: session.messages.map(message => ({
      ...message,
      toolCalls: message.toolCalls?.map(call => ({
        id: call.id,
        name: call.name,
        status: call.status,
        input: {},
        ...(call.media ? { media: call.media } : {}),
      })),
      rounds: message.rounds?.map(({ sent: _sent, ...round }) => round),
      thinking: undefined,
    })),
  };
}

async function memoryFiles(
  session: ChatSession,
  root: string
): Promise<Array<{ project: string; name: string; bytes: Buffer }> | null> {
  if (!session.project) return [];
  const store = await memoryStoreFor(session.project.directory, root);
  const [physicalRoot, physicalDirectory] = await Promise.all([realpath(root), realpath(store.directory)]).catch(
    error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [null, null] as const;
      throw error;
    }
  );
  if (!physicalRoot || !physicalDirectory) return [];
  if (
    !inside(physicalRoot, physicalDirectory) ||
    physicalDirectory !== join(physicalRoot, relative(root, store.directory))
  ) {
    return null;
  }
  let entries;
  try {
    entries = await readdir(store.directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: Array<{ project: string; name: string; bytes: Buffer }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || (entry.name !== 'MEMORY.md' && !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(entry.name))) continue;
    const path = join(store.directory, entry.name);
    if (!(await lstat(path)).isFile()) continue;
    files.push({ project: session.project.directory, name: entry.name, bytes: await readFile(path) });
  }
  return files;
}

/** Only explicit, app-owned records enter the bundle; no userData directory traversal. */
export async function writeLocalDataExport(
  folder: string,
  deps: LocalDataExportDeps
): Promise<{ path: string; warnings: string[] }> {
  await assertDestination(folder, deps.userData);
  const scope = deps.sessions.scopeKey();
  if (!scope) throw new Error('Choose an account or device-local environment before exporting.');
  const bundle = join(folder, `bike4mind-export-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  await mkdir(bundle);
  await mkdir(join(bundle, 'collections'));
  await mkdir(join(bundle, 'files'));
  const warnings: string[] = [];
  const written = new Set<string>();
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  const writers = new Map<Collection, RowWriter>(
    COLLECTIONS.map(name => [
      name,
      {
        stream: createWriteStream(join(bundle, 'collections', `${name}.jsonl`)),
        hash: createHash('sha256'),
        bytes: 0,
        count: 0,
      },
    ])
  );
  for (const { stream } of writers.values()) stream.on('error', () => {});
  const addBlob = async (bytes: Buffer): Promise<string> => {
    const hash = sha256(bytes);
    const path = `files/${hash}`;
    if (!written.has(hash)) {
      await writeFile(join(bundle, path), bytes);
      written.add(hash);
      files.push({ path, sha256: hash, bytes: bytes.length });
    }
    return path;
  };
  const emit = async (name: Collection, row: Row): Promise<void> => {
    const writer = writers.get(name)!;
    const line = Buffer.from(`${JSON.stringify(row)}\n`);
    writer.hash.update(line);
    writer.bytes += line.length;
    writer.count += 1;
    if (!writer.stream.write(line)) {
      await new Promise<void>((resolve, reject) => {
        writer.stream.once('drain', resolve);
        writer.stream.once('error', reject);
      });
    }
  };
  const closeWriters = () =>
    Promise.all(
      [...writers.values()].map(
        ({ stream }) =>
          new Promise<void>((resolve, reject) => {
            stream.once('error', reject);
            stream.end(resolve);
          })
      )
    );

  try {
    const seenMemory = new Set<string>();
    for (const summary of await deps.sessions.list()) {
      if (deps.sessions.scopeKey() !== scope) throw new Error('Account changed during export.');
      if (!isValidSessionId(summary.id)) continue;
      const original = await deps.sessions.get(summary.id);
      if (!original) continue;
      const session = safeSession(original);
      await emit('notebooks', {
        id: session.id,
        name: session.title,
        firstCreated: session.createdAt,
        lastUpdated: session.updatedAt,
        tags: [],
        isAutoNamed: !session.titleLocked,
        lastUsedModel: session.model,
      });
      await emit('desktop-sessions', { id: session.id, session });
      for (const message of session.messages) {
        await emit('chat-messages', {
          notebookId: session.id,
          id: message.id,
          timestamp: message.createdAt,
          type: message.system ? 'system' : 'message',
          prompt: message.role === 'user' ? message.content : '',
          ...(message.role === 'assistant' ? { reply: message.content } : {}),
          status: 'done',
          pinned: false,
        });
        for (const attachment of message.attachments ?? []) {
          const source = await deps.attachments.locate(session.id, attachment.id);
          if (!source) throw new Error(`Missing attachment in ${session.id}.`);
          if (!(await lstat(source)).isFile()) throw new Error(`Invalid attachment in ${session.id}.`);
          const bytes = await readFile(source);
          await emit('knowledge', {
            notebookId: session.id,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mediaType,
            size: bytes.length,
            uploadedAt: message.createdAt,
            contentPath: await addBlob(bytes),
          });
        }
        for (const artifact of message.artifacts ?? [])
          await emit('artifacts', {
            notebookId: session.id,
            id: artifact.id,
            name: artifact.title,
            type: artifact.type,
            content: artifact.content,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
          });
      }
      let mediaEntries: Dirent[];
      try {
        mediaEntries = await readdir(deps.media.directoryFor(session.id), { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mediaEntries = [];
      }
      for (const entry of mediaEntries) {
        if (!entry.isFile()) continue;
        const source = await deps.media.locate(session.id, entry.name);
        if (!source || !(await lstat(source.path)).isFile()) continue;
        await emit('media', {
          notebookId: session.id,
          name: entry.name,
          mimeType: source.mimeType,
          path: await addBlob(await readFile(source.path)),
        });
      }
      if (session.project) {
        const memoryRoot = deps.memoryRoot ?? defaultUserInstructionsRoot();
        const found = await memoryFiles(session, memoryRoot);
        if (found === null) {
          warnings.push(`Skipped project memory for ${session.project.directory}: it resolves outside its folder.`);
          continue;
        }
        for (const memory of found) {
          const key = `${memory.project}\u0000${memory.name}`;
          if (seenMemory.has(key)) continue;
          seenMemory.add(key);
          await emit('memory', { project: memory.project, name: memory.name, path: await addBlob(memory.bytes) });
        }
      }
    }
    if (deps.sessions.scopeKey() !== scope) throw new Error('Account changed during export.');
    await closeWriters();
    if (deps.sessions.scopeKey() !== scope) throw new Error('Account changed during export.');
    const collections: Record<string, { path: string; count: number; bytes: number; sha256: string }> = {};
    for (const [name, writer] of writers) {
      collections[name] = {
        path: `collections/${name}.jsonl`,
        count: writer.count,
        bytes: writer.bytes,
        sha256: writer.hash.digest('hex'),
      };
    }
    await writeFile(
      join(bundle, 'manifest.json'),
      JSON.stringify(
        {
          exportVersion: '2.0.0',
          exportedAt: new Date().toISOString(),
          platform: 'bike4mind',
          collections,
          files,
          ...(warnings.length ? { warnings } : {}),
        },
        null,
        2
      )
    );
    return { path: bundle, warnings };
  } catch (error) {
    for (const { stream } of writers.values()) stream.destroy();
    await rm(bundle, { recursive: true, force: true });
    throw error;
  }
}
