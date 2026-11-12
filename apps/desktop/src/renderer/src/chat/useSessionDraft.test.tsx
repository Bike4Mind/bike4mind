// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewSessionDefaults } from '@shared/sessionDefaults';
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
const defaultsForNewSession = vi.fn();
const setApprovalMode = vi.fn();
const setSessionReasoningEffort = vi.fn();
const setSessionPromptCacheTtl = vi.fn();
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
  defaultsForNewSession.mockResolvedValue({
    model: 'default-model',
    approvalMode: 'auto',
    reasoningEffort: 'high',
    promptCacheTtl: '1h',
  });
  const saved = async () => ({ id: 'created' });
  setApprovalMode.mockResolvedValue({ id: 'created' });
  setSessionReasoningEffort.mockResolvedValue({ id: 'created' });
  setSessionPromptCacheTtl.mockResolvedValue({ id: 'created' });
  Object.assign(window, {
    b4m: {
      chat: {
        createSession,
        defaultsForNewSession,
        createCodeSession,
        sendMessage,
        setSessionModel,
        addContextDirectory,
        copyDraftAttachments,
        discardDraftAttachments,
        deleteSession,
        setApprovalMode,
        setSessionReasoningEffort,
        setSessionGeneration: saved,
        setSessionPromptCacheTtl,
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
  it('uses the remembered starting model without overriding a deliberate draft choice', async () => {
    let resolve!: (defaults: NewSessionDefaults) => void;
    defaultsForNewSession.mockReturnValueOnce(
      new Promise<NewSessionDefaults>(done => {
        resolve = done;
      })
    );
    await act(async () => {
      draft.start('chat');
    });
    await act(async () => controller().setModel('chosen'));
    await act(async () =>
      resolve({ model: 'remembered', approvalMode: 'auto', reasoningEffort: 'high', promptCacheTtl: '1h' })
    );
    expect(draft.session?.model).toBe('chosen');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('retires an accepted draft even if refreshing the sidebar fails', async () => {
    reload.mockRejectedValueOnce(new Error('refresh failed'));
    await act(async () => {
      draft.start('chat');
    });
    await act(async () => {
      expect(await controller().send('Hello')).toBe(true);
    });
    expect(draft.session).toBeNull();
    expect(opened).toHaveBeenCalledWith('created');
    expect(deleteSession).not.toHaveBeenCalled();
  });

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

  it('does not carry a refused-send cleanup failure into the draft opened after navigation', async () => {
    let refuse!: (value: { ok: false; error: string }) => void;
    sendMessage.mockReturnValueOnce(
      new Promise(resolve => {
        refuse = resolve;
      })
    );
    deleteSession.mockRejectedValueOnce(new Error('locked'));
    await act(async () => {
      draft.start('chat');
    });
    const previous = draft.session!.id;
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = controller().send('Hello');
    });
    await act(async () => {
      draft.discard();
      draft.start('chat');
    });
    await act(async () => {
      refuse({ ok: false, error: 'Unavailable' });
      await pending;
    });
    expect(draft.session?.id).not.toBe(previous);
    expect(controller().sendError).toBeNull();
    expect(discardDraftAttachments).toHaveBeenCalledWith(previous);
    expect(opened).not.toHaveBeenCalled();
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
  it('displays effective preferences without rewriting untouched preferences on first send', async () => {
    await act(async () => {
      draft.start('chat');
    });
    expect(draft.session).toMatchObject({ approvalMode: 'auto', reasoningEffort: 'high', promptCacheTtl: '1h' });
    expect(createSession).not.toHaveBeenCalled();
    await act(async () => {
      expect(await controller().send('Hello')).toBe(true);
    });
    expect(setApprovalMode).not.toHaveBeenCalled();
    expect(setSessionReasoningEffort).not.toHaveBeenCalled();
    expect(setSessionPromptCacheTtl).not.toHaveBeenCalled();
  });

  it('preserves deliberate settings through delayed defaults and applies only those choices', async () => {
    let resolve: ((value: NewSessionDefaults) => void) | undefined;
    defaultsForNewSession.mockImplementationOnce(
      () =>
        new Promise<NewSessionDefaults>(done => {
          resolve = done;
        })
    );
    await act(async () => {
      draft.start('chat');
    });
    await act(async () => {
      await controller().setApprovalMode('full');
      await controller().setReasoningEffort('low');
      await controller().setPromptCacheTtl('5m');
    });
    if (!resolve) throw new Error('Missing defaults barrier');
    await act(async () =>
      resolve?.({ model: 'remembered', approvalMode: 'auto', reasoningEffort: 'high', promptCacheTtl: '1h' })
    );
    expect(draft.session).toMatchObject({ approvalMode: 'full', reasoningEffort: 'low', promptCacheTtl: '5m' });
    await act(async () => {
      await controller().send('Hello');
    });
    expect(setApprovalMode).toHaveBeenCalledExactlyOnceWith('created', 'full');
    expect(setSessionReasoningEffort).toHaveBeenCalledExactlyOnceWith('created', 'low');
    expect(setSessionPromptCacheTtl).toHaveBeenCalledExactlyOnceWith('created', '5m');
  });

  it('refreshes defaults before an immediate send without applying placeholder settings', async () => {
    let releaseInitial: ((value: NewSessionDefaults) => void) | undefined;
    defaultsForNewSession.mockImplementationOnce(
      () =>
        new Promise<NewSessionDefaults>(resolve => {
          releaseInitial = resolve;
        })
    );
    await act(async () => {
      draft.start('chat');
    });
    await act(async () => {
      expect(await controller().send('Immediate')).toBe(true);
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(setApprovalMode).not.toHaveBeenCalled();
    expect(setSessionReasoningEffort).not.toHaveBeenCalled();
    await act(async () => releaseInitial?.({ model: 'old', approvalMode: 'ask', reasoningEffort: 'default' }));
    expect(draft.session).toBeNull();
  });

  it('ignores defaults after navigating to a different draft', async () => {
    let resolve: ((value: NewSessionDefaults) => void) | undefined;
    defaultsForNewSession.mockImplementationOnce(
      () =>
        new Promise<NewSessionDefaults>(done => {
          resolve = done;
        })
    );
    await act(async () => {
      draft.start('chat');
    });
    const previous = draft.session!.id;
    await act(async () => {
      draft.discard();
      draft.start('code');
    });
    await act(async () => resolve?.({ model: 'old', approvalMode: 'ask', reasoningEffort: 'low' }));
    expect(draft.session?.id).not.toBe(previous);
    expect(draft.session).toMatchObject({ model: 'default-model', approvalMode: 'auto', reasoningEffort: 'high' });
  });

  it.each(['loop', 'pr', 'compact', 'clear'])('reports unsupported pre-send /%s without materializing', async name => {
    await act(async () => {
      draft.start('chat');
    });
    await act(async () => {
      await controller().runCommand(name, '');
    });
    expect(controller().sendError).toBe(`Send a message first before using /${name}.`);
    expect(createSession).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('keeps an unsent draft retryable when reading preferences fails', async () => {
    await act(async () => {
      draft.start('chat');
    });
    const id = draft.session!.id;
    defaultsForNewSession.mockRejectedValueOnce(new Error('preferences unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await act(async () => {
        expect(await controller().send('Keep this')).toBe(false);
      });
      expect(draft.session?.id).toBe(id);
      expect(controller().sendError).toBe('Could not load new conversation preferences. Try again.');
      expect(createSession).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(discardDraftAttachments).not.toHaveBeenCalled();
      await act(async () => {
        expect(await controller().send('Keep this')).toBe(true);
      });
    } finally {
      warning.mockRestore();
    }
  });
});
