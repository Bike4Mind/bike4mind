// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { HostConnectionState } from '@shared/hostConnection';
import { act } from 'react';
import { chatBackedHostBridge, fakeHostInfo } from '../__fixtures__/chatBackedHostBridge';
import {
  allByTestId,
  byTestId,
  click,
  DESKTOP_VERSION,
  mountHostUi,
  settle,
  textOf,
  type MountedHostUi,
} from '../__fixtures__/mountHostUi';
import { ConnectionsSettings, connectionsAttention, connectionsSummary } from './ConnectionsSettings';

const HOST_ID = 'devbox';
const failure = {
  kind: 'sshFailed',
  detail: 'Connection failed',
  stderrTail: 'Permission denied (publickey).',
} as const;
const current: HostConnectionState = {
  status: 'connected',
  info: {
    ...fakeHostInfo(HOST_ID),
    hostVersion: DESKTOP_VERSION,
    account: { userId: 'u1', environmentUrl: 'https://app.example.com' },
  },
  latencyMs: 30,
};

let mounted: MountedHostUi | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function mountWith(state: HostConnectionState | null, extra: Parameters<typeof chatBackedHostBridge>[0] = {}) {
  const bridge = chatBackedHostBridge({
    remote: state ? { hostId: HOST_ID, label: 'devbox', state } : undefined,
    aliases: state ? [{ alias: 'devbox', hostId: HOST_ID }] : [],
    descriptions: { devbox: { alias: 'devbox', hostname: 'dev.example.com', user: 'sam', port: 2222 } },
    ...extra,
  });
  mounted = await mountHostUi(<ConnectionsSettings />, bridge);
  await settle();
  return bridge;
}

const actionsShown = () =>
  allByTestId('connections-host')
    .flatMap(row => Array.from(row.querySelectorAll<HTMLElement>('[data-testid^="connections-action-"]')))
    .map(button => button.dataset.testid?.replace('connections-action-', '').replace('-btn', ''))
    .filter(Boolean);

describe('Connections page', () => {
  it('shows nothing remote when only the local host exists', async () => {
    await mountWith(null);
    expect(allByTestId('connections-host')).toHaveLength(0);
    expect(byTestId('connections-empty')).not.toBeNull();
  });

  it.each<[string, HostConnectionState, string[]]>([
    ['connected', current, ['reconnect', 'disconnect']],
    ['needs install', { status: 'needsInstall' }, ['install', 'remove']],
    ['needs sign-in', { status: 'needsSignIn' }, ['signIn', 'disconnect', 'remove']],
    ['offline', { status: 'offline', reason: 'unreachable', lastSeenAt: null }, ['reconnect', 'remove']],
    ['failed', { status: 'failed', failure }, ['reconnect', 'remove']],
    ['connecting', { status: 'connecting' }, ['disconnect']],
  ])('renders the right actions for a %s host', async (_name, state, expected) => {
    await mountWith(state);
    expect(actionsShown()).toEqual(expected);
  });

  it('offers an update when the host program differs from this Desktop', async () => {
    await mountWith({ ...current, info: { ...current.info, hostVersion: '1.0.0' } });
    expect(textOf('connections-host-status')).toBe('Update available');
    expect(actionsShown()[0]).toBe('update');
  });

  it('shows endpoint, host version and account for a connected host', async () => {
    await mountWith(current);
    expect(textOf('connections-host-endpoint')).toBe('sam@dev.example.com:2222');
    expect(textOf('connections-host-version')).toContain(`Host version ${DESKTOP_VERSION}`);
    expect(textOf('connections-host-version')).toContain('app.example.com');
  });

  it('lists unadded ssh aliases and adds one', async () => {
    const bridge = await mountWith(null, {
      aliases: [{ alias: 'gpu', hostId: null }],
      descriptions: { gpu: { alias: 'gpu', hostname: 'gpu.example.com', user: 'sam', port: 22 } },
    });
    expect(byTestId('connections-alias')?.dataset.alias).toBe('gpu');
    await click('connections-alias-add-btn');
    expect(bridge.management.added).toEqual(['gpu']);
  });

  it('asks for consent once, naming what is written and where, before installing', async () => {
    const bridge = await mountWith({ status: 'needsInstall' });
    await click('connections-action-install-btn');
    expect(bridge.management.installs).toEqual([]);
    expect(textOf('host-install-consent')).toContain('~/.b4m/host');
    await click('host-install-consent-confirm-btn');
    expect(bridge.management.installs).toEqual([HOST_ID]);
  });

  it('does not install when consent is declined', async () => {
    const bridge = await mountWith({ status: 'needsInstall' });
    await click('connections-action-install-btn');
    await click('host-install-consent-cancel-btn');
    expect(bridge.management.installs).toEqual([]);
    expect(byTestId('host-install-consent')).toBeNull();
  });

  it('shows install progress', async () => {
    const bridge = await mountWith({ status: 'needsInstall' });
    let release: () => void = () => undefined;
    bridge.install = () =>
      new Promise(resolve => (release = () => resolve({ status: 'installed', version: 'x', restarted: false })));
    await click('connections-action-install-btn');
    await click('host-install-consent-confirm-btn');
    await act(async () =>
      bridge.management.emitProgress({
        hostId: HOST_ID,
        progress: { phase: 'uploading', sentBytes: 50, totalBytes: 100 },
      })
    );
    expect(textOf('connections-host-operation-progress')).toContain('Uploading');
    expect(textOf('connections-host-status')).toBe('Installing');
    await act(async () => release());
  });

  it('asks before an update that would stop running sessions, and forces only on yes', async () => {
    const bridge = await mountWith({ ...current, info: { ...current.info, hostVersion: '1.0.0' } });
    bridge.management.updateResults = [
      {
        status: 'confirmationRequired',
        work: { kind: 'sessions', sessions: [{ sessionId: 's1', status: 'processing', backgroundJobs: 0 }] },
      },
      { status: 'installed', version: DESKTOP_VERSION, restarted: true },
    ];
    await click('connections-action-update-btn');
    expect(bridge.management.updates).toEqual([{ hostId: HOST_ID, force: false }]);
    expect(textOf('host-update-confirm-work')).toContain('1 session is running');
    await click('host-update-confirm-btn');
    expect(bridge.management.updates[1]).toEqual({ hostId: HOST_ID, force: true });
    expect(byTestId('host-update-confirm')).toBeNull();
  });

  it('keeps everything running when the update question is declined', async () => {
    const bridge = await mountWith({ ...current, info: { ...current.info, hostVersion: '1.0.0' } });
    bridge.management.updateResults = [{ status: 'confirmationRequired', work: { kind: 'unknown' } }];
    await click('connections-action-update-btn');
    await click('host-update-cancel-btn');
    expect(bridge.management.updates).toHaveLength(1);
  });

  it('removes a host only after confirmation', async () => {
    const bridge = await mountWith({ status: 'needsInstall' });
    await click('connections-action-remove-btn');
    expect(bridge.management.removes).toEqual([]);
    await click('host-remove-confirm-btn');
    expect(bridge.management.removes).toEqual([HOST_ID]);
  });

  it('connects and disconnects through the bridge', async () => {
    const bridge = await mountWith({ status: 'offline', reason: 'disconnected', lastSeenAt: null });
    await click('connections-action-connect-btn');
    expect(bridge.management.connects).toEqual([HOST_ID]);
  });

  it('shows what ssh wrote as text, with a copyable ssh command', async () => {
    await mountWith({
      status: 'failed',
      failure: { ...failure, stderrTail: '<img src=x onerror=alert(1)> Permission denied' },
    });
    const message = byTestId('connections-host-failure-message');
    expect(message?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(message?.querySelector('img')).toBeNull();
    expect(textOf('connections-host-failure-command')).toBe('ssh devbox');
    expect(byTestId('connections-host-failure-copy-btn')).not.toBeNull();
  });
});

describe('summaries', () => {
  it('counts hosts and names what needs the user', () => {
    const entry = (state: HostConnectionState) => ({ hostId: 'a', label: 'a', kind: 'remote' as const, state });
    expect(connectionsSummary([])).toMatch(/No remote hosts/);
    expect(connectionsSummary([entry(current)])).toBe('1 host, 1 connected');
    expect(connectionsAttention([entry({ status: 'needsSignIn' })])).toBe('Sign in');
    expect(connectionsAttention([entry({ status: 'failed', failure })])).toBe('Failed');
    expect(connectionsAttention([entry(current)])).toBeUndefined();
  });
});
