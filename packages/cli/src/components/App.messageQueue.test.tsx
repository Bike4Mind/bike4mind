/**
 * Mid-turn input routing through the real input: Enter queues a steer for the
 * running turn, Tab queues a follow-up turn, and both render above the input
 * with the routing hint. Idle input still runs immediately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from './App';
import { useCliStore } from '../store';

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
}

let fakeStdout: FakeStdout;
let directories: string[];

vi.mock('ink', async importOriginal => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({ stdout: fakeStdout, write: () => {} }),
  };
});

// eslint-disable-next-line no-control-regex
const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '');

const noop = () => {};
const asyncNoop = async () => {};

function renderApp(onMessage: (message: string) => Promise<void> = asyncNoop) {
  return render(
    <App
      onMessage={onMessage}
      onCommand={asyncNoop}
      onBashCommand={noop}
      onPermissionResponse={noop}
      onUserQuestionResponse={noop}
      onReviewGateResponse={noop}
    />
  );
}

/** Type `text` and press `key`, letting Ink process each write. */
async function submit(stdin: { write: (data: string) => void }, text: string, key: '\r' | '\t') {
  for (const char of text) {
    stdin.write(char);
    await new Promise(resolve => setImmediate(resolve));
  }
  stdin.write(key);
  await new Promise(resolve => setImmediate(resolve));
}

describe('App mid-turn message queue', () => {
  beforeEach(() => {
    fakeStdout = new FakeStdout();
    directories = [];
    useCliStore.setState({
      messageQueue: [],
      inputValue: '',
      isThinking: false,
      turnInFlight: false,
      peerTurnActive: false,
    });
  });

  afterEach(async () => {
    useCliStore.setState({
      messageQueue: [],
      inputValue: '',
      isThinking: false,
      turnInFlight: false,
      peerTurnActive: false,
    });
    await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  });

  it.each([false, true])(
    'keeps expanded human file input in its own turn when peer work is %s',
    async peerTurnActive => {
      const directory = await mkdtemp(join(tmpdir(), 'b4m-peer-human-input-'));
      directories.push(directory);
      const file = join(directory, 'private.txt');
      await writeFile(file, 'HUMAN_FILE_MARKER');
      useCliStore.setState({ isThinking: true, turnInFlight: true, peerTurnActive });
      const onMessage = vi.fn(asyncNoop);
      const { stdin, lastFrame, unmount } = renderApp(onMessage);
      try {
        await submit(stdin, `explain @${file} `, '\r');
        await vi.waitFor(() => expect(useCliStore.getState().messageQueue).toHaveLength(1));
        const queued = useCliStore.getState().messageQueue[0];
        expect(queued).toMatchObject({ kind: peerTurnActive ? 'followUp' : 'steer', typed: `explain @${file}` });
        expect(queued.text).toContain('HUMAN_FILE_MARKER');
        expect(onMessage).not.toHaveBeenCalled();
        if (peerTurnActive) {
          await vi.waitFor(() =>
            expect(stripAnsi(lastFrame() ?? '')).toContain('Peer work does not receive your input')
          );
        }
      } finally {
        unmount();
      }
    }
  );

  it('queues both Enter and Tab separately from peer work, including cancellation unwind', async () => {
    useCliStore.setState({ isThinking: false, turnInFlight: true, peerTurnActive: true });
    const { stdin, unmount } = renderApp();
    try {
      await submit(stdin, 'human Enter', '\r');
      await submit(stdin, 'human Tab', '\t');
      await vi.waitFor(() =>
        expect(useCliStore.getState().messageQueue).toEqual([
          { text: 'human Enter', kind: 'followUp' },
          { text: 'human Tab', kind: 'followUp' },
        ])
      );
    } finally {
      unmount();
    }
  });

  it('queues Enter as a steer and Tab as a follow-up while a turn runs, and shows both', async () => {
    useCliStore.setState({ isThinking: true, turnInFlight: true });
    const onMessage = vi.fn(asyncNoop);
    const { stdin, lastFrame, unmount } = renderApp(onMessage);

    await submit(stdin, 'use pnpm', '\r');
    await vi.waitFor(() => expect(useCliStore.getState().messageQueue).toHaveLength(1));
    await submit(stdin, 'then the changelog', '\t');

    await vi.waitFor(() =>
      expect(useCliStore.getState().messageQueue).toEqual([
        { text: 'use pnpm', kind: 'steer' },
        { text: 'then the changelog', kind: 'followUp' },
      ])
    );
    expect(onMessage).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('use pnpm');
      expect(frame).toContain('[next turn] then the changelog');
      expect(frame).toContain('Tab queues for next turn');
    });
    unmount();
  });

  it('queues input submitted while a cancelled turn is still unwinding', async () => {
    useCliStore.setState({ isThinking: false, turnInFlight: true });
    const onMessage = vi.fn(asyncNoop);
    const { stdin, unmount } = renderApp(onMessage);

    await submit(stdin, 'after esc', '\r');

    await vi.waitFor(() => expect(useCliStore.getState().messageQueue).toEqual([{ text: 'after esc', kind: 'steer' }]));
    expect(onMessage).not.toHaveBeenCalled();
    unmount();
  });

  it('queues Enter as a follow-up while busy without a turn to steer (e.g. a custom command)', async () => {
    useCliStore.setState({ isThinking: true, turnInFlight: false });
    const { stdin, unmount } = renderApp();

    await submit(stdin, 'next', '\r');

    await vi.waitFor(() => expect(useCliStore.getState().messageQueue).toEqual([{ text: 'next', kind: 'followUp' }]));
    unmount();
  });

  it('runs input immediately when idle, and Tab does not submit', async () => {
    const onMessage = vi.fn(asyncNoop);
    const { stdin, unmount } = renderApp(onMessage);

    await submit(stdin, 'hello', '\t');
    expect(onMessage).not.toHaveBeenCalled();
    stdin.write('\r');

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith('hello'));
    expect(useCliStore.getState().messageQueue).toEqual([]);
    unmount();
  });
});
