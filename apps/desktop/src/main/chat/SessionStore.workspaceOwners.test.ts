import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatProject } from '@shared/chat';
import { SessionStore } from './SessionStore';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-workspace-owners-'));
  roots.push(directory);
  const project: ChatProject = {
    directory,
    name: 'Project',
    branch: 'main',
    workspace: true,
    workspaceBranch: 'b4m/task-abc123',
    workingDirectory: join(directory, 'checkout'),
    contextDirectories: [join(directory, 'reference')],
  };
  const sessions = join(directory, 'sessions');
  const scoped = (accountId: string, environmentUrl = 'http://localhost:3000') =>
    new SessionStore(sessions, 'model', 'launch', () => ({ accountId, environmentUrl }));
  return { directory, project, sessions, scoped };
}

describe('SessionStore workspace owners', () => {
  it('preserves foreign account, environment and local bindings without exposing their titles', async () => {
    const { project, sessions, scoped } = await fixture();
    const current = scoped('current');
    await current.create(undefined, { project, title: 'Current title' });
    await scoped('other').create(undefined, { project, title: 'Private account title' });
    await scoped('current', 'http://localhost:4000').create(undefined, { project, title: 'Private environment title' });
    await new SessionStore(sessions, 'model').create(undefined, { project, title: 'Private local title' });

    const owners = await current.workspaceOwnersExcept('');
    expect(owners).toHaveLength(4);
    expect(owners.map(owner => owner.title).sort()).toEqual([
      'Another conversation',
      'Another conversation',
      'Another conversation',
      'Current title',
    ]);
    for (const owner of owners) {
      expect(owner.project).toEqual(project);
      expect(owner.directories).toEqual([project.directory, project.workingDirectory, ...project.contextDirectories]);
    }
  });

  it('includes grants from a projectless conversation and excludes only the requested session', async () => {
    const { directory, scoped } = await fixture();
    const store = scoped('current');
    const first = await store.create(undefined, { title: 'Reference', grantedDirectories: [directory] });
    const excluded = await store.create(undefined, { title: 'Excluded', grantedDirectories: [directory] });
    const owners = await store.workspaceOwnersExcept(excluded.id);
    expect(owners).toEqual([{ title: 'Reference', directories: [directory] }]);
    expect(await store.workspaceProjectsExcept(excluded.id)).toEqual([]);
    expect((await store.get(first.id))?.grantedDirectories).toEqual([directory]);
  });

  it('fails closed on malformed grants instead of treating the checkout as unowned', async () => {
    const { sessions, scoped } = await fixture();
    const store = scoped('current');
    const session = await store.create();
    await writeFile(
      join(sessions, store.scopeKey()!, `${session.id}.json`),
      JSON.stringify({ grantedDirectories: [42] })
    );
    await expect(store.workspaceOwnersExcept('')).rejects.toThrow();
  });
});
