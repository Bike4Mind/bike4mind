/**
 * The permission prompt's kind is set by the prompt callback that enqueues it and read by
 * <PermissionPrompt> through the store. This drives that whole path for a sandbox escalation:
 * if the kind is dropped anywhere between the store and the component, the generic tool menu
 * renders for what is an unsandboxed-retry question.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from './App';
import type { PermissionResponse } from './PermissionPrompt';
import { useCliStore } from '../store';

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
}

let fakeStdout: FakeStdout;

vi.mock('ink', async importOriginal => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({ stdout: fakeStdout, write: () => {} }),
  };
});

const noop = () => {};
const asyncNoop = async () => {};

function renderApp(onPermissionResponse: (response: PermissionResponse, promptId: string) => void) {
  return render(
    <App
      onMessage={asyncNoop}
      onCommand={asyncNoop}
      onBashCommand={noop}
      onPermissionResponse={onPermissionResponse}
      onUserQuestionResponse={noop}
      onReviewGateResponse={noop}
    />
  );
}

describe('App sandbox escalation prompt', () => {
  beforeEach(() => {
    fakeStdout = new FakeStdout();
    useCliStore.setState({
      permissionPrompt: {
        id: 'prompt-1',
        toolName: 'bash_execute',
        args: { command: 'touch /etc/hosts' },
        preview: 'SANDBOX BLOCKED',
        canBeTrusted: true,
        kind: 'sandbox-escalation',
        resolve: noop,
      },
    });
  });

  afterEach(() => {
    useCliStore.setState({ permissionPrompt: null });
  });

  it('renders the escalation menu and answers through onPermissionResponse', async () => {
    const onPermissionResponse = vi.fn();
    const { lastFrame, stdin, unmount } = renderApp(onPermissionResponse);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Retry once without sandbox');
    expect(frame).not.toContain('Always allow');

    stdin.write('\r');
    await vi.waitFor(() => expect(onPermissionResponse).toHaveBeenCalledWith('allow-once', 'prompt-1'));
    unmount();
  });
});
