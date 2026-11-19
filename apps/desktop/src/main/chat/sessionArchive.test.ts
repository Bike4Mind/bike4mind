import { describe, expect, it, vi } from 'vitest';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { ChatSessionSummary } from '@shared/chat';
import { archiveFromSidebar } from './sessionArchive';

const session = (id: string, parentSessionId?: string): ChatSessionSummary => ({
  id,
  title: id,
  model: 'test',
  mode: 'chat',
  approvalMode: 'ask',
  reasoningEffort: 'default',
  createdAt: '',
  updatedAt: '',
  messageCount: 0,
  ...(parentSessionId ? { origin: { parentSessionId, depth: 1, seedPrompt: 'test' } } : {}),
});

function setup(children: string[] = []) {
  const parent = session('parent');
  const service = {
    listSessions: vi.fn(async () => [parent, ...children.map(id => session(id, parent.id))]),
    childArchiveStatus: vi.fn(
      (entry: Pick<ChatSessionSummary, 'id' | 'workerTask'>): 'finished' | 'running' | 'waiting' =>
        entry.id === 'running' ? 'running' : entry.id === 'waiting' ? 'waiting' : 'finished'
    ),
    setSessionArchived: vi.fn(async (_id: string, _archived: boolean) => parent),
    archiveFinishedChildren: vi.fn(async () => undefined),
  };
  const store = { scopeKey: vi.fn(() => 'scope') };
  const confirm = vi.fn<(options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>(async () => ({
    response: 0,
    checkboxChecked: true,
  }));
  return {
    service,
    store,
    confirm,
    run: (archived = true) => archiveFromSidebar(service, store, parent.id, archived, confirm),
  };
}

describe('sidebar archive confirmation', () => {
  it('offers finished children default-on and lists running and waiting children as kept', async () => {
    const { service, confirm, run } = setup(['finished', 'running', 'waiting']);
    await run();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ checkboxChecked: true, checkboxLabel: 'Also archive finished sub-sessions (1)' })
    );
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ detail: expect.stringContaining('Kept (running): running') });
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ detail: expect.stringContaining('Kept (waiting): waiting') });
    expect(service.archiveFinishedChildren).toHaveBeenCalledWith('parent', ['finished'], 'scope');
  });

  it('allows opting out', async () => {
    const { service, confirm, run } = setup(['finished']);
    confirm.mockResolvedValue({ response: 0, checkboxChecked: false });
    await run();
    expect(service.setSessionArchived).toHaveBeenCalledWith('parent', true);
    expect(service.archiveFinishedChildren).not.toHaveBeenCalled();
  });

  it.each(['running', 'waiting'])('keeps an only %s child', async status => {
    const { service, confirm, run } = setup([status]);
    await run();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining(`Kept (${status}): ${status}`) })
    );
    expect(confirm.mock.calls[0]?.[0]).not.toHaveProperty('checkboxLabel');
    expect(service.archiveFinishedChildren).not.toHaveBeenCalled();
  });

  it('archives a childless parent without confirmation and restores without confirmation', async () => {
    const { service, confirm, run } = setup();
    await run();
    await run(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(service.setSessionArchived.mock.calls).toEqual([
      ['parent', true],
      ['parent', false],
    ]);
  });

  it('cancels without archiving anything', async () => {
    const { service, confirm, run } = setup(['finished']);
    confirm.mockResolvedValue({ response: 1, checkboxChecked: true });
    await run();
    expect(service.setSessionArchived).not.toHaveBeenCalled();
  });

  it('does not archive across an account switch while confirming', async () => {
    const { service, store, confirm, run } = setup(['finished']);
    confirm.mockImplementation(async () => {
      store.scopeKey.mockReturnValue('other');
      return { response: 0, checkboxChecked: true };
    });
    await run();
    expect(service.setSessionArchived).not.toHaveBeenCalled();
  });
});
