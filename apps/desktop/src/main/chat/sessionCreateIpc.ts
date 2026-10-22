import type { IpcMain } from 'electron';
import type {
  ChatSessionSummary,
  CreateCodeSessionRequest,
  CreateCodeSessionResult,
} from '@shared/chat';
import {
  IPC_CHANNELS,
  type CreateCodeSessionIpcRequest,
  type CreateCodeSessionIpcResult,
  type CreateSessionRequest,
  type CreatedSession,
} from '@shared/ipc';
import { folderToRemember } from './project/recentFolderToRecord';
import type { PlacementOutcome } from './sidebarIpc';

/** What the create handlers need from main; kept apart from the IPC so they can be tested alone. */
export interface SessionCreation {
  createSession: () => Promise<ChatSessionSummary>;
  createCodeSession: (request: CreateCodeSessionRequest) => Promise<CreateCodeSessionResult>;
  /** Files a freshly minted session; see placeNewSession. */
  place: (sessionId: string, sectionId: unknown) => Promise<PlacementOutcome>;
  rememberFolder: (directory: string | null) => void;
}

const placement = (outcome: PlacementOutcome): Pick<CreatedSession, 'sidebarSections' | 'placementFailed'> => ({
  sidebarSections: outcome.sections,
  placementFailed: outcome.failed || undefined,
});

export function registerSessionCreateIpc(ipc: Pick<IpcMain, 'handle'>, creation: SessionCreation): void {
  ipc.handle(
    IPC_CHANNELS.chatCreateSession,
    async (_event, request: CreateSessionRequest | undefined): Promise<CreatedSession> => {
      const session = await creation.createSession();
      return { session, ...placement(await creation.place(session.id, request?.sectionId)) };
    }
  );

  ipc.handle(
    IPC_CHANNELS.chatCreateCodeSession,
    async (_event, request: CreateCodeSessionIpcRequest): Promise<CreateCodeSessionIpcResult> => {
      const result = await creation.createCodeSession(request);
      creation.rememberFolder(folderToRemember(request, result));
      if (!result.ok) return result;
      return { ...result, ...placement(await creation.place(result.session.id, request.sectionId)) };
    }
  );
}
