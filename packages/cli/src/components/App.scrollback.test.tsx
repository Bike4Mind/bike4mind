/**
 * Regression guard for the real defect: Ink repaints the live frame in place
 * only while it fits the viewport. Any taller frame goes through
 * `ansiEscapes.clearTerminal`, which includes ESC[3J ("erase scrollback"), so a
 * spinner ticking over an overflowing frame wipes scrollback ~12x/sec and the
 * terminal can never stay scrolled up.
 *
 * These tests drive the real Ink renderer against a fake TTY and assert the
 * escape never reaches stdout while the agent is thinking. The last case is a
 * control: it renders a deliberately overflowing frame to prove the assertion
 * has teeth.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render, Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { App } from './App';
import { useCliStore } from '../store';
import type { Message } from '../storage';
import type { AgentStep } from '@bike4mind/agents';

const COLUMNS = 100;
const ROWS = 24;
const ERASE_SCROLLBACK = '[3J';

class FakeTtyStdout extends EventEmitter {
  isTTY = true;
  columns = COLUMNS;
  rows = ROWS;
  writes: string[] = [];

  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }

  get all() {
    return this.writes.join('');
  }
}

class FakeTtyStdin extends EventEmitter {
  isTTY = true;
  setRawMode() {
    return this;
  }
  setEncoding() {
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  read() {
    return null;
  }
  ref() {}
  unref() {}
}

let stdout: FakeTtyStdout;
let stdin: FakeTtyStdin;

const renderWithFakeTty = (node: React.ReactElement) =>
  render(node, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout: stdout as any, // any: fake TTY stream, only the bits Ink touches
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdin: stdin as any, // any: same, for the stdin side
    exitOnCtrlC: false,
    patchConsole: false,
  });

/** Long enough for several ink-spinner frames (80ms each) to be written. */
const letTheSpinnerTick = () => new Promise(resolve => setTimeout(resolve, 300));

const thoughtStep = (i: number): AgentStep => ({
  type: 'thought',
  content: `considering option ${i} in some detail`,
  metadata: { timestamp: 0 },
});

const pendingMessage = (stepCount: number): Message => ({
  id: 'pending-1',
  role: 'assistant',
  content: '...',
  timestamp: new Date(0).toISOString(),
  metadata: { steps: Array.from({ length: stepCount }, (_, i) => thoughtStep(i)) },
});

const noop = () => {};
const asyncNoop = async () => {};

function renderApp() {
  return renderWithFakeTty(
    <App
      onMessage={asyncNoop}
      onCommand={asyncNoop}
      onBashCommand={noop}
      onPermissionResponse={noop}
      onUserQuestionResponse={noop}
      onReviewGateResponse={noop}
    />
  );
}

describe('App does not clobber scrollback while thinking', () => {
  beforeEach(() => {
    stdout = new FakeTtyStdout();
    stdin = new FakeTtyStdin();
  });

  afterEach(() => {
    useCliStore.setState({ pendingMessages: [], isThinking: false, messageQueue: [] });
    vi.unstubAllEnvs();
  });

  it('never erases scrollback for a long step trace', async () => {
    useCliStore.setState({ pendingMessages: [pendingMessage(80)], isThinking: true });

    const instance = renderApp();
    await letTheSpinnerTick();
    // Ink clears once at teardown for a frame that filled the viewport; the
    // defect is the per-frame wipe while the spinner runs, so measure the writes
    // made before unmount.
    const duringRun = stdout.all;
    instance.unmount();

    expect(duringRun).not.toContain(ERASE_SCROLLBACK);
  });

  it('never erases scrollback on a short terminal', async () => {
    stdout.rows = 12;
    useCliStore.setState({ pendingMessages: [pendingMessage(80)], isThinking: true });

    const instance = renderApp();
    await letTheSpinnerTick();
    const duringRun = stdout.all;
    instance.unmount();

    expect(duringRun).not.toContain(ERASE_SCROLLBACK);
  });

  it('control: an overflowing live frame does erase scrollback', async () => {
    const Overflowing = () => (
      <Box flexDirection="column">
        {Array.from({ length: ROWS * 2 }, (_, i) => (
          <Text key={i}>{`row ${i}`}</Text>
        ))}
        <Text>
          <Spinner type="dots" />
        </Text>
      </Box>
    );

    const instance = renderWithFakeTty(<Overflowing />);
    await letTheSpinnerTick();
    instance.unmount();

    expect(stdout.all).toContain(ERASE_SCROLLBACK);
  });
});
