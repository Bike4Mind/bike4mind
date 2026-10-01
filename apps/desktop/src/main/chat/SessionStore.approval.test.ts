import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalModePreference } from './ApprovalModePreference';
import { SessionStore } from './SessionStore';

describe('SessionStore approval mode', () => {
  let directory: string;
  /** Beside the sessions directory, the way the app places it. */
  let preferenceFile: string;
  let store: SessionStore;

  /**
   * The same files, as a later run of the app sees them - including the preference, which is
   * read from disk again rather than from the instance that wrote it.
   */
  const relaunch = () =>
    new SessionStore(directory, 'test-model', 'launch-two', undefined, new ApprovalModePreference(preferenceFile));

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'b4m-approval-store-'));
    directory = join(base, 'sessions');
    preferenceFile = join(base, 'approval-mode.json');
    store = new SessionStore(
      directory,
      'test-model',
      'launch-one',
      undefined,
      new ApprovalModePreference(preferenceFile)
    );
  });

  it('starts a new conversation at "Approve for me"', async () => {
    const created = await store.create();
    expect(created.approvalMode).toBe('auto');
    expect(await store.approvalMode(created.id)).toBe('auto');
  });

  /**
   * The preference is about the NEXT conversation. A mode chosen in one thread must not reach
   * back into the threads already on disk, whose stored mode is their own.
   */
  it('starts the next conversation in the mode the user picked last', async () => {
    const first = await store.create();
    await store.setApprovalMode(first.id, 'ask');

    const second = await store.create();
    expect(second.approvalMode).toBe('ask');
    expect(await store.approvalMode(first.id)).toBe('ask');
  });

  it('keeps that pick across a relaunch, so it is not re-made every morning', async () => {
    const first = await store.create();
    await store.setApprovalMode(first.id, 'ask');
    expect((await relaunch().create()).approvalMode).toBe('ask');
  });

  /**
   * 'full' is scoped to the run of the app it was chosen in, so a new conversation inheriting
   * it would outlive the choice - the same reason a spawned session does not inherit it.
   */
  it('never carries "Full access" into the next conversation', async () => {
    const first = await store.create();
    await store.setApprovalMode(first.id, 'full');

    const second = await store.create();
    expect(second.approvalMode).toBe('auto');
    expect(second.approvalMode).not.toBe('full');
    expect((await relaunch().create()).approvalMode).toBe('auto');
  });

  it('leaves a conversation already on disk at the mode it was given', async () => {
    const existing = await store.create();
    await store.setApprovalMode(existing.id, 'auto');

    const later = await store.create();
    await store.setApprovalMode(later.id, 'ask');

    expect(await store.approvalMode(existing.id)).toBe('auto');
  });

  it('starts at "Approve for me" when no preference has been written', async () => {
    const fresh = new SessionStore(directory, 'test-model', 'launch-one');
    expect((await fresh.create()).approvalMode).toBe('auto');
  });

  it('reads a conversation written before approval modes existed as ask', async () => {
    const created = await store.create();
    const path = join(directory, `${created.id}.json`);
    const legacy = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete legacy.approvalMode;
    await store.setApprovalMode(created.id, 'ask');
    expect((await store.get(created.id))?.approvalMode).toBe('ask');
  });

  it('keeps "Approve for me" across a relaunch, which is the point of persisting it at all', async () => {
    const created = await store.create();
    await store.setApprovalMode(created.id, 'auto');
    expect(await relaunch().approvalMode(created.id)).toBe('auto');
  });

  /**
   * The deliberate asymmetry. 'full' is the mode with nothing between a crafted prompt and a
   * read of any file on the machine, and it is chosen for a piece of work the user is watching;
   * one that quietly outlived the app it was set in is not the thing they chose.
   */
  it('drops "Full access" back to asking on the next launch', async () => {
    const created = await store.create();
    await store.setApprovalMode(created.id, 'full');
    expect(await store.approvalMode(created.id)).toBe('full');

    expect(await relaunch().approvalMode(created.id)).toBe('ask');
  });

  it('lands a stale "Full access" on ask rather than on the next mode down', async () => {
    const created = await store.create();
    await store.setApprovalMode(created.id, 'full');
    const reopened = relaunch();
    expect(await reopened.approvalMode(created.id)).toBe('ask');

    // And the stamp does not survive: re-choosing 'full' in the new run has to be its own act.
    await reopened.setApprovalMode(created.id, 'auto');
    expect(await new SessionStore(directory, 'test-model', 'launch-three').approvalMode(created.id)).toBe('auto');
  });

  it('keeps the mode through an unrelated write, so a turn does not reset it', async () => {
    const created = await store.create();
    await store.setApprovalMode(created.id, 'auto');
    await store.appendMessage(created.id, {
      id: 'm1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    });
    expect(await store.approvalMode(created.id)).toBe('auto');
  });

  it('reads a session that is not there as ask, which fails closed', async () => {
    const created = await store.create();
    const path = join(directory, `${created.id}.json`);
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(raw.approvalMode).toBe('auto');
    expect(await store.approvalMode('no-such-session')).toBe('ask');
  });

  /** A spawn names the mode it inherited, and that beats the preference without recording it. */
  it('carries an inherited mode onto a session created with one', async () => {
    const child = await store.create('test-model', { approvalMode: 'ask' });
    expect(child.approvalMode).toBe('ask');
    expect((await store.create()).approvalMode).toBe('auto');
  });
});
