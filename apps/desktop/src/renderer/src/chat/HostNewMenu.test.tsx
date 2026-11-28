// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { HostConnectionState } from '@shared/hostConnection';
import { chatBackedHostBridge, fakeHostInfo } from '../__fixtures__/chatBackedHostBridge';
import {
  allByTestId,
  byTestId,
  click,
  mountHostUi,
  settle,
  textOf,
  type MountedHostUi,
} from '../__fixtures__/mountHostUi';
import { HostNewMenu } from './HostNewMenu';

const connected: HostConnectionState = { status: 'connected', info: fakeHostInfo('devbox'), latencyMs: 5 };
let mounted: MountedHostUi | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

type Picks = { starts: string[]; adds: [string, string][] };
async function mountMenu(state: HostConnectionState | null) {
  const picks: Picks = { starts: [], adds: [] };
  const bridge = chatBackedHostBridge({
    remote: state
      ? {
          hostId: 'devbox',
          label: 'Devbox',
          state,
          answer: method => {
            if (method === 'project/recent') return { folders: [] };
            if (method !== 'fs/browse') return undefined;
            return {
              path: '/home/test',
              parent: null,
              entries: [{ name: 'app', path: '/home/test/app', isGitRepository: true }],
            };
          },
        }
      : undefined,
  });
  mounted = await mountHostUi(
    <HostNewMenu
      onNewSessionOnHost={id => picks.starts.push(id)}
      onAddProject={(id, directory) => picks.adds.push([id, directory])}
      pickLocalFolder={async () => '/Users/me/app'}
    />,
    bridge
  );
  await settle();
  return picks;
}

describe('host new menu', () => {
  it('draws nothing with only this computer', async () => {
    await mountMenu(null);
    expect(byTestId('host-new-menu-btn')).toBeNull();
  });

  it('draws nothing while the only remote host is not connected', async () => {
    await mountMenu({ status: 'offline', reason: 'unreachable', lastSeenAt: null });
    expect(byTestId('host-new-menu-btn')).toBeNull();
  });

  it('offers a new session on each connected host', async () => {
    const picks = await mountMenu(connected);
    await click('host-new-menu-btn');
    expect(textOf('host-new-session-devbox')).toContain('New session on Devbox');
    await click('host-new-session-devbox');
    expect(picks.starts).toEqual(['devbox']);
  });

  it('asks where the project is, then adds a folder from this computer', async () => {
    const picks = await mountMenu(connected);
    await click('host-new-menu-btn');
    await click('host-add-project');
    expect(byTestId('add-project-dialog')).not.toBeNull();
    await click('add-project-continue-btn');
    await settle();
    expect(picks.adds).toEqual([['local', '/Users/me/app']]);
  });

  it('browses the host to add a remote project', async () => {
    const picks = await mountMenu(connected);
    await click('host-new-menu-btn');
    await click('host-add-project');
    const radio = byTestId('add-project-host-devbox')?.querySelector<HTMLInputElement>('input') ?? null;
    if (!radio) throw new Error('no host radio');
    await (await import('react')).act(async () => radio.click());
    await click('add-project-continue-btn');
    await settle();
    expect(byTestId('host-folder-picker')).not.toBeNull();
    expect(allByTestId('host-folder-picker-entry').length).toBeGreaterThan(0);
    await click('host-folder-picker-choose-btn');
    expect(picks.adds[0]?.[0]).toBe('devbox');
  });
});
