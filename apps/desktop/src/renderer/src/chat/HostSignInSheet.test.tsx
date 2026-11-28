// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatBackedHostBridge, fakeHostInfo } from '../__fixtures__/chatBackedHostBridge';
import { byTestId, click, mountHostUi, settle, textOf, type MountedHostUi } from '../__fixtures__/mountHostUi';
import { useHostEntries } from '../host/hostRegistry';
import { HostSignInSheet } from './HostSignInSheet';

const HOST_ID = 'devbox';
let mounted: MountedHostUi | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function Harness({ onClose }: { onClose: () => void }) {
  const entry = useHostEntries().find(candidate => candidate.hostId === HOST_ID);
  return entry ? <HostSignInSheet entry={entry} onClose={onClose} /> : null;
}

async function open(grants: { userCode: string; expiresIn: number }[]) {
  const starts = vi.fn();
  const queue = [...grants];
  const bridge = chatBackedHostBridge({
    remote: {
      hostId: HOST_ID,
      state: { status: 'needsSignIn' },
      answer: method => {
        if (method !== 'host/auth/start') return undefined;
        starts();
        const grant = queue.shift() ?? grants[grants.length - 1]!;
        return {
          verificationUrl: 'https://app.example.com/device',
          userCode: grant.userCode,
          expiresAt: Date.now() + grant.expiresIn,
        };
      },
    },
  });
  const onClose = vi.fn();
  mounted = await mountHostUi(<Harness onClose={onClose} />, bridge);
  await settle();
  return { bridge, onClose, starts };
}

describe('host sign-in sheet', () => {
  it('shows a copyable code and link, opens the browser here, and closes when the host is signed in', async () => {
    const { bridge, onClose, starts } = await open([{ userCode: 'ABCD-1234', expiresIn: 60_000 }]);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(textOf('host-signin-code')).toBe('ABCD-1234');
    expect(textOf('host-signin-link')).toBe('https://app.example.com/device');
    expect(byTestId('host-signin-copy-code-btn')).not.toBeNull();
    expect(mounted?.openExternal).toHaveBeenCalledWith('https://app.example.com/device');
    expect(onClose).not.toHaveBeenCalled();

    await act(async () =>
      bridge.remote?.setState({
        status: 'connected',
        info: fakeHostInfo(HOST_ID),
        latencyMs: 10,
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it.each([
    ['offline', { status: 'offline', reason: 'unreachable', lastSeenAt: null }],
    ['failed', { status: 'failed', failure: { kind: 'sshFailed', detail: 'no route', stderrTail: '' } }],
    [
      'accountMismatch',
      { status: 'accountMismatch', hostAccount: { userId: 'other', environmentUrl: 'https://x.test' } },
    ],
  ] as const)(
    'stays open with the reason and a way back when the host drops to %s mid sign-in',
    async (_name, state) => {
      const { bridge, onClose } = await open([{ userCode: 'ABCD-1234', expiresIn: 60_000 }]);
      await act(async () => bridge.remote?.setState(state));
      expect(onClose).not.toHaveBeenCalled();
      expect(byTestId('host-signin-interrupted')).not.toBeNull();
      expect(byTestId('host-signin-code')).toBeNull();
      await click('host-signin-reconnect-btn');
      expect(bridge.management.connects).toEqual([HOST_ID]);
    }
  );

  it('shows a connecting state, not a failure, while the host reconnects after approval', async () => {
    const { bridge, onClose } = await open([{ userCode: 'ABCD-1234', expiresIn: 60_000 }]);
    await act(async () => bridge.remote?.setState({ status: 'connecting' }));
    expect(byTestId('host-signin-connecting')).not.toBeNull();
    expect(byTestId('host-signin-interrupted')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => bridge.remote?.setState({ status: 'connected', info: fakeHostInfo(HOST_ID), latencyMs: 10 }));
    expect(onClose).toHaveBeenCalled();
  });

  it('says the code expired and gets a new one on retry', async () => {
    const { starts } = await open([
      { userCode: 'FIRST-0001', expiresIn: 30 },
      { userCode: 'SECOND-0002', expiresIn: 60_000 },
    ]);
    await act(async () => new Promise(resolve => setTimeout(resolve, 80)));
    expect(byTestId('host-signin-expired')).not.toBeNull();
    await click('host-signin-retry-btn');
    await settle();
    expect(starts).toHaveBeenCalledTimes(2);
    expect(textOf('host-signin-code')).toBe('SECOND-0002');
  });

  it('shows the failure when the host cannot start a sign-in, and offers a retry', async () => {
    const bridge = chatBackedHostBridge({
      remote: { hostId: HOST_ID, state: { status: 'needsSignIn' }, failing: ['host/auth/start'] },
    });
    mounted = await mountHostUi(<Harness onClose={() => undefined} />, bridge);
    await settle();
    expect(byTestId('host-signin-failed')).not.toBeNull();
    expect(byTestId('host-signin-retry-btn')).not.toBeNull();
  });
});
