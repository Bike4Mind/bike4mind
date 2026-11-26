import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import {
  archiveConfirmationDialog,
  archiveDecisionFrom,
  archiveFromSidebar,
  confirmArchiveFromIpc,
  type ArchiveConfirmation,
  type ArchiveConfirmationAnswer,
  type ArchiveDecision,
} from './sessionArchive';

/** The client's half: ask when the first answer carries a question, then send the decision. */
async function archiveAskingFirst(
  archive: (decision?: ArchiveDecision) => ReturnType<typeof archiveFromSidebar>,
  confirm: (confirmation: ArchiveConfirmation) => Promise<ArchiveConfirmationAnswer>
): Promise<ChatSessionSummary | null> {
  const first = await archive();
  if (!first.confirmationRequired) return first.summary;
  const decision = archiveDecisionFrom(
    first.confirmationRequired,
    await confirm(archiveConfirmationDialog(first.confirmationRequired))
  );
  return decision ? (await archive(decision)).summary : null;
}

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
  const confirm = vi.fn<(confirmation: ArchiveConfirmation) => Promise<ArchiveConfirmationAnswer>>(async () => ({
    response: 0,
    checkboxChecked: true,
  }));
  const archive = (decision?: ArchiveDecision) => archiveFromSidebar(service, store, parent.id, true, decision);
  return {
    service,
    store,
    confirm,
    archive,
    run: (archived = true) =>
      archived ? archiveAskingFirst(archive, confirm) : archiveFromSidebar(service, store, parent.id, false),
  };
}

describe('archiving a parent session', () => {
  it('changes nothing without confirmation and returns what the question needs', async () => {
    const { service, archive } = setup(['finished', 'running', 'waiting']);

    await expect(archive()).resolves.toEqual({
      summary: null,
      confirmationRequired: {
        parentTitle: 'parent',
        finished: [{ id: 'finished', title: 'finished' }],
        kept: [
          { id: 'running', title: 'running', status: 'running' },
          { id: 'waiting', title: 'waiting', status: 'waiting' },
        ],
      },
    });
    expect(service.setSessionArchived).not.toHaveBeenCalled();
  });

  it('archives the parent and only the children the decision names once confirmed', async () => {
    const { service, archive } = setup(['finished', 'running']);

    await expect(archive({ confirmed: true, archiveChildIds: ['finished'] })).resolves.toMatchObject({
      summary: { id: 'parent' },
    });
    expect(service.setSessionArchived).toHaveBeenCalledWith('parent', true);
    expect(service.archiveFinishedChildren).toHaveBeenCalledWith('parent', ['finished'], 'scope');
  });

  it('archives a childless session and restores one without asking', async () => {
    const { service, archive } = setup();

    await expect(archive()).resolves.toMatchObject({ summary: { id: 'parent' } });
    await archiveFromSidebar(service, { scopeKey: () => 'scope' }, 'parent', false);
    expect(service.setSessionArchived.mock.calls).toEqual([
      ['parent', true],
      ['parent', false],
    ]);
    expect(service.archiveFinishedChildren).not.toHaveBeenCalled();
  });

  it('does nothing for a session the current account does not have', async () => {
    const { service, archive } = setup(['finished']);
    service.listSessions.mockResolvedValue([]);

    await expect(archive({ confirmed: true, archiveChildIds: ['finished'] })).resolves.toEqual({ summary: null });
    expect(service.setSessionArchived).not.toHaveBeenCalled();
  });
});

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
    const { service, confirm, run } = setup(['finished']);
    confirm.mockImplementation(async () => {
      service.listSessions.mockResolvedValue([]);
      return { response: 0, checkboxChecked: true };
    });
    await run();
    expect(service.setSessionArchived).not.toHaveBeenCalled();
  });
});

describe('confirmArchiveFromIpc', () => {
  const question = {
    parentTitle: 'Parent',
    finished: [{ id: 'a', title: 'A' }],
    kept: [{ id: 'b', title: 'B', status: 'running' }],
  };

  it('returns null without showing the dialog when the question is malformed', async () => {
    const show = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await confirmArchiveFromIpc({ parentTitle: 1 }, show)).toBeNull();
    expect(show).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Ignoring an invalid archive confirmation question', expect.anything());
    warn.mockRestore();
  });

  it('maps a confirmed answer with the checkbox ticked to the finished sub-session ids', async () => {
    const show = vi.fn(async () => ({ response: 0, checkboxChecked: true }));
    expect(await confirmArchiveFromIpc(question, show)).toEqual({ confirmed: true, archiveChildIds: ['a'] });
    expect(show).toHaveBeenCalledOnce();
  });

  it('returns null when the user cancels', async () => {
    expect(await confirmArchiveFromIpc(question, async () => ({ response: 1, checkboxChecked: true }))).toBeNull();
  });
});
