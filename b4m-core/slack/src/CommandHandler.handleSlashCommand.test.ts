import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSlackDeps, getSlackDb } = vi.hoisted(() => ({
  getSlackDeps: vi.fn(),
  getSlackDb: vi.fn(),
}));
vi.mock('./di/registry', () => ({ getSlackDeps, getSlackDb, configureSlackPackage: vi.fn() }));

import { CommandHandler } from './CommandHandler';
import { SlackEvent } from './SlackEvent';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const sessionExists = vi.fn();
const findByIdAndUpdate = vi.fn();
const NOTEBOOK_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

function setNotebook(id: string) {
  const slackEvent = new SlackEvent({ channel: 'D1', user: 'U1', text: `/notebook set ${id}`, ts: '1.1' } as never);
  return new CommandHandler(slackEvent, { id: 'user-1', slackSettings: {} } as never, {} as never, logger);
}

beforeEach(() => {
  vi.clearAllMocks();
  getSlackDb.mockReturnValue({ Session: { exists: sessionExists }, User: { findByIdAndUpdate } });
});

describe('CommandHandler.handleSlashCommand /notebook set', () => {
  it('stores a notebook the user owns', async () => {
    sessionExists.mockResolvedValue({ _id: NOTEBOOK_ID });

    await setNotebook(NOTEBOOK_ID).handleSlashCommand();

    expect(sessionExists).toHaveBeenCalledWith({ _id: NOTEBOOK_ID, userId: 'user-1' });
    expect(findByIdAndUpdate).toHaveBeenCalledWith(
      'user-1',
      { $set: { slackSettings: expect.objectContaining({ defaultNotebookId: NOTEBOOK_ID }) } },
      expect.any(Object)
    );
  });

  it('refuses a notebook the user does not own', async () => {
    sessionExists.mockResolvedValue(null);

    const reply = await setNotebook(NOTEBOOK_ID).handleSlashCommand();

    expect(reply).toContain('not found');
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a notebook id without querying', async () => {
    const reply = await setNotebook('not-an-id').handleSlashCommand();

    expect(reply).toContain('not found');
    expect(sessionExists).not.toHaveBeenCalled();
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
