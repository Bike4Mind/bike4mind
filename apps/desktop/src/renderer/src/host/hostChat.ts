import type {
  ActiveContextNotice,
  ChatApprovalAnswer,
  ChatModelCatalog,
  ChatQueuedMessage,
  ChatSession,
  ChatSessionSummary,
  ProjectInspection,
  RecentFolder,
  SendMessageRequest,
  SendMessageResult,
} from '@shared/chat';
import type { PlacedCodeSessionRequest, PlacedCodeSessionResult } from '@shared/ipc';
import type { TaskDecisionAnswer } from '@shared/orchestration';
import type { NewSessionDefaults } from '@shared/sessionDefaults';
import type { SessionTreeDeletion } from '@shared/worktreeRemoval';
import type { HostResult } from '@shared/hostProtocol';
import { hostClient, type HostClient } from './HostClient';
import { hostForSession } from './sessionHost';

/** The Desktop-only calls the session flows need beside the host: sidebar placement and native dialogs. */
export type LocalDesktop = {
  confirmArchive: Window['b4m']['chat']['confirmArchive'];
  moveToSection: Window['b4m']['sidebar']['moveSession'];
};

export type DeleteOptions = {
  removeWorktree?: boolean;
  /** Only after showing the user what worktree cleanup discards; see session/delete. */
  allowDiscard: boolean;
};

export type FolderListing = HostResult<'fs/browse'>;

/**
 * The renderer's chat calls over the host protocol. A call about a session goes to the host that
 * session lives on (see hostForSession); a call with no session yet (a new session, a project
 * lookup, recent folders) names its host, since the caller knows which host it is working on.
 * Failures reject with HostRequestError, whose message is the host's. pickProjectDirectory is not
 * here: it is a native picker, valid only for the local host (see HostFolderPicker for the rest).
 */
export function createHostChat(client: HostClient, local: () => LocalDesktop) {
  return {
    /** Null when the session is gone (deleted elsewhere, or a stale id). */
    async getSession(sessionId: string, viewed?: boolean): Promise<ChatSession | null> {
      const { session } = await client.request(hostForSession(sessionId), 'session/get', {
        sessionId,
        ...(viewed ? { viewed } : {}),
      });
      return session;
    },

    /** The session with the held context notices in force for it (none from a 1.2 host). */
    async readSession(
      sessionId: string,
      viewed?: boolean
    ): Promise<{ session: ChatSession | null; notices: ActiveContextNotice[] }> {
      const { session, notices } = await client.request(hostForSession(sessionId), 'session/get', {
        sessionId,
        ...(viewed ? { viewed } : {}),
      });
      return { session, notices: notices ?? [] };
    },

    /** Sidebar placement is Desktop's own, so a requested section is applied here after the host creates the session. */
    async createCodeSession(
      hostId: string,
      { sectionId, ...request }: PlacedCodeSessionRequest
    ): Promise<PlacedCodeSessionResult> {
      const result = await client.request(hostId, 'session/create', request);
      if (!result.ok || !sectionId) return result;
      try {
        return { ...result, sidebarSections: await local().moveToSection(result.session.id, sectionId) };
      } catch (cause) {
        console.warn('Could not place the new session in its section', cause);
        return { ...result, placementFailed: true };
      }
    },

    async renameSession(sessionId: string, title: string): Promise<ChatSessionSummary | null> {
      const { summary } = await client.request(hostForSession(sessionId), 'session/rename', { sessionId, title });
      return summary;
    },

    /**
     * Archives or restores at once, except a parent with sub-sessions still going: then the user
     * is asked first, and null means they cancelled or the session is unknown.
     */
    async setSessionArchived(sessionId: string, archived: boolean): Promise<ChatSessionSummary | null> {
      const hostId = hostForSession(sessionId);
      const first = await client.request(hostId, 'session/setArchived', { sessionId, archived });
      if (!first.confirmationRequired) return first.summary;
      const answer = await local().confirmArchive(first.confirmationRequired);
      if (!answer) return null;
      const { summary } = await client.request(hostId, 'session/setArchived', { sessionId, archived, ...answer });
      return summary;
    },

    async deleteSession(sessionId: string, { removeWorktree = false, allowDiscard }: DeleteOptions): Promise<void> {
      await client.request(hostForSession(sessionId), 'session/delete', { sessionId, removeWorktree, allowDiscard });
    },

    /** Nested sessions go deepest first, then the session; `error` is the first failure, after which nothing more goes. */
    deleteSessionTree(
      sessionId: string,
      nestedIds: readonly string[],
      removeWorktree: boolean,
      nestedWorktreeIds: readonly string[],
      allowDiscard?: boolean
    ): Promise<SessionTreeDeletion> {
      return client.request(hostForSession(sessionId), 'session/deleteTree', {
        sessionId,
        nestedIds: [...nestedIds],
        removeWorktree,
        nestedWorktreeIds: [...nestedWorktreeIds],
        allowDiscard,
      });
    },

    /** Resolves when the turn is accepted; the reply arrives as the session's stream events. */
    sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
      return client.request(hostForSession(request.sessionId), 'turn/send', request);
    },

    async stopReply(sessionId: string): Promise<void> {
      await client.request(hostForSession(sessionId), 'turn/stop', { sessionId });
    },

    /** `sessionId` is the session the approval belongs to, which picks the host that holds it. */
    async respondToApproval(sessionId: string, approvalId: string, answer: ChatApprovalAnswer): Promise<void> {
      await client.request(hostForSession(sessionId), 'request/respond', {
        kind: 'approval',
        requestId: approvalId,
        answer,
      });
    },

    async answerTaskDecision(sessionId: string, decisionId: string, answer: TaskDecisionAnswer): Promise<void> {
      await client.request(hostForSession(sessionId), 'request/respond', {
        kind: 'taskDecision',
        sessionId,
        decisionId,
        answer,
      });
    },

    async getQueuedMessages(sessionId: string): Promise<ChatQueuedMessage[]> {
      const { queued } = await client.request(hostForSession(sessionId), 'queue/list', { sessionId });
      return queued;
    },

    async cancelQueuedMessage(sessionId: string, queuedId: string): Promise<void> {
      await client.request(hostForSession(sessionId), 'queue/cancel', { sessionId, queuedId });
    },

    async sendQueuedMessageNow(sessionId: string, queuedId: string): Promise<void> {
      await client.request(hostForSession(sessionId), 'queue/sendNow', { sessionId, queuedId });
    },

    /** `force` skips the host's cache; `'local'` re-reads device and server models but keeps the hosted list. */
    async listModels(force?: boolean | 'local'): Promise<ChatModelCatalog> {
      const { models } = await client.request(hostForSession(), 'model/list', force === undefined ? {} : { force });
      return models;
    },

    async defaultsForNewSession(hostId: string): Promise<NewSessionDefaults> {
      const { defaults } = await client.request(hostId, 'draft/defaults');
      return defaults;
    },

    async listRecentFolders(hostId: string): Promise<RecentFolder[]> {
      const { folders } = await client.request(hostId, 'project/recent');
      return folders;
    },

    /** Forgets one folder (the folder itself is untouched) and resolves to the list that is left. */
    async removeRecentFolder(hostId: string, directory: string): Promise<RecentFolder[]> {
      const { folders } = await client.request(hostId, 'project/forgetRecent', { path: directory });
      return folders;
    },

    async inspectProject(hostId: string, directory: string): Promise<ProjectInspection> {
      const { inspection } = await client.request(hostId, 'project/inspect', { directory });
      return inspection;
    },

    /** The folders inside `path` on the host (its home directory when absent); see fs/browse. */
    browseFolder(hostId: string, path?: string): Promise<FolderListing> {
      return client.request(hostId, 'fs/browse', path === undefined ? {} : { path });
    },
  };
}

export type HostChat = ReturnType<typeof createHostChat>;

export const hostChat: HostChat = createHostChat(hostClient, () => ({
  confirmArchive: question => window.b4m.chat.confirmArchive(question),
  moveToSection: (sessionId, sectionId) => window.b4m.sidebar.moveSession(sessionId, sectionId),
}));
