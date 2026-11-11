import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
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
): Promise<Array<{ project: string; name: string; bytes: Buffer }>> {
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
    throw new Error('Project memory resolves outside its folder.');
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
export async function writeLocalDataExport(folder: string, deps: LocalDataExportDeps): Promise<string> {
  await assertDestination(folder, deps.userData);
  const scope = deps.sessions.scopeKey();
  if (!scope) throw new Error('Choose an account or device-local environment before exporting.');
  const bundle = join(folder, `bike4mind-export-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  await mkdir(bundle);
  const rows = Object.fromEntries(COLLECTIONS.map(name => [name, [] as Row[]])) as unknown as Record<Collection, Row[]>;
  const blobs = new Map<string, Buffer>();
  const addBlob = (bytes: Buffer): string => {
    const hash = sha256(bytes);
    blobs.set(hash, bytes);
    return `files/${hash}`;
  };

  try {
    const seenMemory = new Set<string>();
    for (const summary of await deps.sessions.list()) {
      if (deps.sessions.scopeKey() !== scope) throw new Error('Account changed during export.');
      if (!isValidSessionId(summary.id)) continue;
      const original = await deps.sessions.get(summary.id);
      if (!original) continue;
      const session = safeSession(original);
      rows.notebooks.push({
        id: session.id,
        name: session.title,
        firstCreated: session.createdAt,
        lastUpdated: session.updatedAt,
        tags: [],
        isAutoNamed: !session.titleLocked,
        lastUsedModel: session.model,
      });
      rows['desktop-sessions'].push({ id: session.id, session });
      for (const message of session.messages) {
        rows['chat-messages'].push({
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
          rows.knowledge.push({
            notebookId: session.id,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mediaType,
            size: bytes.length,
            uploadedAt: message.createdAt,
            contentPath: addBlob(bytes),
          });
        }
        for (const artifact of message.artifacts ?? [])
          rows.artifacts.push({
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
        rows.media.push({
          notebookId: session.id,
          name: entry.name,
          mimeType: source.mimeType,
          path: addBlob(await readFile(source.path)),
        });
      }
      if (session.project) {
        for (const memory of await memoryFiles(session, deps.memoryRoot ?? defaultUserInstructionsRoot())) {
          const key = `${memory.project}\u0000${memory.name}`;
          if (seenMemory.has(key)) continue;
          seenMemory.add(key);
          rows.memory.push({ project: memory.project, name: memory.name, path: addBlob(memory.bytes) });
        }
      }
    }
    if (deps.sessions.scopeKey() !== scope) throw new Error('Account changed during export.');
    const collections: Record<string, { path: string; count: number; bytes: number; sha256: string }> = {};
    await mkdir(join(bundle, 'collections'));
    await mkdir(join(bundle, 'files'));
    for (const name of COLLECTIONS) {
      const path = `collections/${name}.jsonl`;
      const bytes = Buffer.from(
        rows[name].map(row => JSON.stringify(row)).join('\n') + (rows[name].length ? '\n' : '')
      );
      await writeFile(join(bundle, path), bytes);
      collections[name] = { path, count: rows[name].length, bytes: bytes.length, sha256: sha256(bytes) };
    }
    const files = [];
    for (const [hash, bytes] of blobs) {
      const path = `files/${hash}`;
      await writeFile(join(bundle, path), bytes);
      files.push({ path, sha256: hash, bytes: bytes.length });
    }
    await writeFile(
      join(bundle, 'manifest.json'),
      JSON.stringify(
        { exportVersion: '2.0.0', exportedAt: new Date().toISOString(), platform: 'bike4mind', collections, files },
        null,
        2
      )
    );
    return bundle;
  } catch (error) {
    await rm(bundle, { recursive: true, force: true });
    throw error;
  }
}
