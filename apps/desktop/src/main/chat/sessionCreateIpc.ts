import type { IpcMain } from 'electron';
import type { ChatSessionSummary } from '@shared/chat';
import { IPC_CHANNELS, type CreateSessionRequest, type CreatedSession } from '@shared/ipc';
import type { PlacementOutcome } from './sidebarIpc';

/** What the create handlers need from main; kept apart from the IPC so they can be tested alone. */
export interface SessionCreation {
  createSession: (mode: PlainSessionMode) => Promise<ChatSessionSummary>;
  /** Files a freshly minted session; see placeNewSession. */
  place: (sessionId: string, sectionId: unknown) => Promise<PlacementOutcome>;
}

export type PlainSessionMode = NonNullable<CreateSessionRequest['mode']>;

/** The renderer's request is untrusted: anything but an explicit 'studio' starts a Chat session. */
export function plainSessionMode(value: unknown): PlainSessionMode {
  return value === 'studio' ? 'studio' : 'chat';
}

const placement = (outcome: PlacementOutcome): Pick<CreatedSession, 'sidebarSections' | 'placementFailed'> => ({
  sidebarSections: outcome.sections,
  placementFailed: outcome.failed || undefined,
});

export function registerSessionCreateIpc(ipc: Pick<IpcMain, 'handle'>, creation: SessionCreation): void {
  ipc.handle(
    IPC_CHANNELS.chatCreateSession,
    async (_event, request: CreateSessionRequest | undefined): Promise<CreatedSession> => {
      const session = await creation.createSession(plainSessionMode(request?.mode));
      return { session, ...placement(await creation.place(session.id, request?.sectionId)) };
    }
  );
}
