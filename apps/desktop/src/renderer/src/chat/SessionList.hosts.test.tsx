// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import type { HostConnectionState } from '@shared/hostConnection';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { chatBackedHostBridge, fakeHostInfo } from '../__fixtures__/chatBackedHostBridge';
import {
  allByTestId,
  byTestId,
  click,
  DESKTOP_VERSION,
  mountHostUi,
  settle,
  type MountedHostUi,
} from '../__fixtures__/mountHostUi';
import type { HostListingState } from './useChat';
import { SessionList } from './SessionList';

vi.mock('./SessionBadge', () => ({ SessionBadge: () => null }));
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const HOST_ID = 'devbox';
const connected: HostConnectionState = {
  status: 'connected',
  info: { ...fakeHostInfo(HOST_ID), hostVersion: DESKTOP_VERSION },
  latencyMs: 5,
};
const offline: HostConnectionState = { status: 'offline', reason: 'unreachable', lastSeenAt: null };

const codeSession = (id: string, hostId: string | undefined): ChatSessionSummary =>
  ({
    id,
    title: `Task ${id}`,
    mode: 'code',
    messageCount: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    project: { directory: hostId ? '/srv/app' : '/Users/me/app', name: 'app' },
    ...(hostId ? { hostId } : {}),
  }) as ChatSessionSummary;

function list(
  sessions: ChatSessionSummary[],
  hostListings?: ReadonlyMap<string, HostListingState>,
  onNewSessionOnHost: (hostId: string) => void = () => {}
) {
  return (
    <SessionList
      sessions={sessions}
      mode="code"
      loading={false}
      activeId={null}
      statuses={new Map()}
      prSummaries={new Map()}
      collapsed={false}
      onToggleCollapsed={() => {}}
      onSelect={() => {}}
      onCreate={() => {}}
      onOpenArtifacts={() => {}}
      onCreateInProject={() => {}}
      onCreateInSection={() => {}}
      onDelete={() => {}}
      onTogglePin={() => {}}
      onToggleArchived={() => {}}
      onRename={() => {}}
      onDownload={() => {}}
      userSections={EMPTY_SIDEBAR_SECTIONS}
      sectionActions={{ create: () => {}, rename: () => {}, remove: () => {}, move: () => {} }}
      hostListings={hostListings}
      onNewSessionOnHost={onNewSessionOnHost}
      onAddProject={() => {}}
    />
  );
}

let mounted: MountedHostUi | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('sidebar with remote hosts', () => {
  it('draws no host chrome when only this computer exists', async () => {
    const bridge = chatBackedHostBridge();
    mounted = await mountHostUi(list([codeSession('a', undefined)]), bridge);
    await settle();
    expect(byTestId('host-badge')).toBeNull();
    expect(byTestId('host-new-menu-btn')).toBeNull();
    expect(byTestId('host-stale-note')).toBeNull();
    expect(byTestId('host-list-placeholder')).toBeNull();
    expect(allByTestId('host-project-frame')).toHaveLength(0);
  });

  it('badges the remote project only, and shows the New on a host menu', async () => {
    const bridge = chatBackedHostBridge({ remote: { hostId: HOST_ID, state: connected } });
    mounted = await mountHostUi(
      list([codeSession('a', undefined), codeSession('b', HOST_ID)], new Map([[HOST_ID, 'live']])),
      bridge
    );
    await settle();
    expect(allByTestId('host-badge')).toHaveLength(1);
    expect(byTestId('host-badge')?.dataset.hostId).toBe(HOST_ID);
    expect(byTestId('host-new-menu-btn')).not.toBeNull();
  });

  it('keeps cached sessions visible, marked stale and greyed, while the host is offline', async () => {
    const bridge = chatBackedHostBridge({ remote: { hostId: HOST_ID, state: offline } });
    mounted = await mountHostUi(list([codeSession('b', HOST_ID)], new Map([[HOST_ID, 'stale']])), bridge);
    await settle();
    expect(byTestId('host-stale-note')).not.toBeNull();
    expect(byTestId('host-project-frame')?.dataset.offline).toBe('true');
    expect(byTestId('chat-session-title-text')?.textContent).toBe('Task b');
  });

  it('shows skeleton rows while a host first list loads', async () => {
    const bridge = chatBackedHostBridge({ remote: { hostId: HOST_ID, state: connected } });
    mounted = await mountHostUi(list([], new Map([[HOST_ID, 'loading']])), bridge);
    await settle();
    expect(byTestId('host-list-placeholder')?.dataset.hostId).toBe(HOST_ID);
    expect(byTestId('chat-sessions-empty')).toBeNull();
  });

  it('draws no skeleton for a host that is not connecting, so a stuck host never loads forever', async () => {
    const failed = { status: 'failed', failure: { kind: 'sshFailed', detail: 'no route', stderrTail: '' } } as const;
    const bridge = chatBackedHostBridge({ remote: { hostId: HOST_ID, state: failed } });
    mounted = await mountHostUi(list([], new Map([[HOST_ID, 'stale']])), bridge);
    await settle();
    expect(byTestId('host-list-placeholder')).toBeNull();
  });

  it('starts a session on a connected host from the menu', async () => {
    const bridge = chatBackedHostBridge({ remote: { hostId: HOST_ID, state: connected } });
    const started: string[] = [];
    mounted = await mountHostUi(
      list([], undefined, id => started.push(id)),
      bridge
    );
    await click('host-new-menu-btn');
    await click(`host-new-session-${HOST_ID}`);
    expect(started).toEqual([HOST_ID]);
  });
});
