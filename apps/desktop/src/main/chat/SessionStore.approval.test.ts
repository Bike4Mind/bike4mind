import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from './SessionStore';

describe('SessionStore approval mode', () => {
  let directory: string;
  let store: SessionStore;

  /** The same files, as a later run of the app sees them. */
  const relaunch = () => new SessionStore(directory, 'test-model', 'launch-two');

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'b4m-approval-store-'));
    store = new SessionStore(directory, 'test-model', 'launch-one');
  });

  it('starts every new conversation at the safest mode', async () => {
    const created = await store.create();
    expect(created.approvalMode).toBe('ask');
    expect(await store.approvalMode(created.id)).toBe('ask');
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

  it('reads an unknown stored value as ask', async () => {
    const created = await store.create();
    const path = join(directory, `${created.id}.json`);
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(raw.approvalMode).toBe('ask');
    expect(await store.approvalMode('no-such-session')).toBe('ask');
  });

  it('carries an inherited mode onto a session created with one', async () => {
    const child = await store.create('test-model', { approvalMode: 'auto' });
    expect(child.approvalMode).toBe('auto');
  });
});
