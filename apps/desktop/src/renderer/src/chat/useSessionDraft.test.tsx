// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationController } from './useChat';
import { useSessionDraft } from './useSessionDraft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let draft: ReturnType<typeof useSessionDraft>;
const opened = vi.fn();
const reload = vi.fn(async () => undefined);
const createSession = vi.fn();
const createCodeSession = vi.fn();
const sendMessage = vi.fn();
const setSessionModel = vi.fn();
const addContextDirectory = vi.fn();
const copyDraftAttachments = vi.fn();
const discardDraftAttachments = vi.fn();
const deleteSession = vi.fn();
const controller = () => draft.wrap({} as ConversationController);
function Harness() {
  draft = useSessionDraft(opened, reload);
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  createSession.mockResolvedValue({ session: { id: 'created' } });
  createCodeSession.mockResolvedValue({ ok: true, session: { id: 'created' } });
  sendMessage.mockResolvedValue({ ok: true, messageId: 'message' });
  setSessionModel.mockResolvedValue({ id: 'created' });
  addContextDirectory.mockResolvedValue({ status: 'added' });
  copyDraftAttachments.mockResolvedValue(undefined);
  discardDraftAttachments.mockResolvedValue(undefined);
  deleteSession.mockResolvedValue(undefined);
  const saved = async () => ({ id: 'created' });
  Object.assign(window, {
    b4m: {
      chat: {
        createSession,
        createCodeSession,
        sendMessage,
        setSessionModel,
        addContextDirectory,
        copyDraftAttachments,
        discardDraftAttachments,
        deleteSession,
        setApprovalMode: saved,
        setSessionReasoningEffort: saved,
        setSessionGeneration: saved,
        setSessionPromptCacheTtl: saved,
        setSessionHistory: saved,
      },
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('renderer-only session drafts', () => {
  it('reuses New without creating or listing a session, and discards on navigation', async () => {
    let first = '';
    await act(async () => {
      first = draft.start('chat');
    });
    await act(async () => {
      expect(draft.start('chat')).toBe(first);
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    await act(async () => draft.discard());
    expect(draft.session).toBeNull();
    expect(discardDraftAttachments).toHaveBeenCalledWith(first);
    await act(async () => {
      expect(draft.start('chat')).not.toBe(first);
    });
  });

  it('materializes once with draft model, folders, project, worktree and section', async () => {
    const placed = vi.fn();
    const sections = { sections: [], assignments: {} };
    createCodeSession.mockResolvedValue({ ok: true, session: { id: 'created' }, sidebarSections: sections });
    await act(async () => {
      draft.start('code', { directory: '/repo', workspace: true }, { sectionId: 'work', placed, failed: vi.fn() });
    });
    await act(async () => controller().setModel('chosen-model'));
    await act(async () => draft.share('/shared'));
    const id = draft.session!.id;
    await act(async () => {
      await Promise.all([controller().send('Build it'), controller().send('Duplicate')]);
    });
    expect(createCodeSession).toHaveBeenCalledExactlyOnceWith({
      directory: '/repo',
      branch: '',
      workspace: true,
      sectionId: 'work',
    });
    expect(setSessionModel).toHaveBeenCalledWith('created', 'chosen-model');
    expect(addContextDirectory).toHaveBeenCalledWith('created', '/shared');
    expect(copyDraftAttachments).toHaveBeenCalledWith(id, 'created', []);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ sessionId: 'created', text: 'Build it', attachments: [] });
    expect(placed).toHaveBeenCalledWith(sections);
    expect(opened).toHaveBeenCalledExactlyOnceWith('created');
    expect(draft.session).toBeNull();
  });

  it('keeps the draft and rolls back a refused first send', async () => {
    sendMessage.mockResolvedValue({ ok: false, error: 'Model unavailable' });
    await act(async () => {
      draft.start('chat');
    });
    const id = draft.session!.id;
    await act(async () => {
      expect(await controller().send('Keep this')).toBe(false);
    });
    expect(draft.session?.id).toBe(id);
    expect(controller().sendError).toBe('Model unavailable');
    expect(deleteSession).toHaveBeenCalledWith('created');
    expect(opened).not.toHaveBeenCalled();
  });

  it('does not reopen a materialized session after navigation during the send', async () => {
    let accept!: (value: { ok: true; messageId: string }) => void;
    sendMessage.mockReturnValue(
      new Promise(resolve => {
        accept = resolve;
      })
    );
    await act(async () => {
      draft.start('chat');
    });
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = controller().send('Hello');
    });
    await act(async () => draft.discard());
    await act(async () => {
      accept({ ok: true, messageId: 'first' });
      await pending;
    });
    expect(opened).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('materializes Chat folders and staged attachments only on send', async () => {
    await act(async () => {
      draft.start('chat');
    });
    await act(async () => draft.share('/notes'));
    expect(createSession).not.toHaveBeenCalled();
    const attachment = {
      id: 'file-one',
      kind: 'text' as const,
      name: 'notes.txt',
      mediaType: 'text/plain',
      byteSize: 4,
      sourceBytes: 4,
    };
    const id = draft.session!.id;
    await act(async () => {
      await controller().send('Read this', [attachment]);
    });
    expect(addContextDirectory).toHaveBeenCalledWith('created', '/notes');
    expect(copyDraftAttachments).toHaveBeenCalledWith(id, 'created', ['file-one']);
    expect(sendMessage).toHaveBeenCalledWith({ sessionId: 'created', text: 'Read this', attachments: [attachment] });
  });
});
