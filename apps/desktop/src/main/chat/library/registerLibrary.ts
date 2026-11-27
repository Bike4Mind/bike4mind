import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { libraryItemRefSchema, libraryPageRequestSchema } from '@shared/library';
import type { AuthService } from '../../auth/AuthService';
import type { SessionStore } from '../SessionStore';
import type { MediaStore } from '../media/MediaStore';
import { MediaApiClient } from '../media/MediaApiClient';
import { StudioWorkspaceStore } from '../studio/StudioWorkspaceStore';
import { LibraryService } from './LibraryService';

/**
 * The Library place's IPC. Reads Studio workspaces through its own StudioWorkspaceStore over the
 * same folder registerStudio uses (the store keeps no state of its own), only to find the
 * session a Studio Create saved an item into.
 */
export function registerLibrary(deps: {
  ipc: IpcMain;
  directory: string;
  sessions: SessionStore;
  media: MediaStore;
  auth: AuthService;
}): LibraryService {
  const { sessions, auth } = deps;
  const workspaces = new StudioWorkspaceStore(join(deps.directory, 'studio'), sessions);
  const service = new LibraryService({
    connection: () => {
      const scope = sessions.scopeKey();
      const api = auth.getSessionBoundApiClient();
      return scope && api ? { scope, client: new MediaApiClient(api) } : null;
    },
    media: deps.media,
    sessions: async () => (await sessions.list()).map(session => ({ id: session.id, mode: session.mode })),
    listJobs: (sessionId, cursor) => workspaces.listJobs(sessionId, cursor ? { cursor } : {}),
  });
  deps.ipc.handle(IPC_CHANNELS.libraryPage, (_event, raw: unknown) =>
    service.page(libraryPageRequestSchema.parse(raw))
  );
  deps.ipc.handle(IPC_CHANNELS.libraryMedia, (_event, raw: unknown) => service.media(libraryItemRefSchema.parse(raw)));
  deps.ipc.handle(IPC_CHANNELS.libraryLocate, (_event, raw: unknown) =>
    service.locate(libraryItemRefSchema.parse(raw))
  );
  return service;
}
