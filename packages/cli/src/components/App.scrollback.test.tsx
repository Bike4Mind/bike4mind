/**
 * Regression guard for the real defect: Ink repaints the live frame in place
 * only while it fits the viewport. Any taller frame goes through
 * `ansiEscapes.clearTerminal`, which includes ESC[3J ("erase scrollback"), so a
 * frame that overflows wipes scrollback on every repaint and the terminal can
 * never stay scrolled up.
 *
 * These tests drive the real Ink renderer against a fake TTY and assert the
 * escape never reaches stdout while the agent is thinking. Frames are driven by
 * store updates rather than by waiting on the spinner: a fixed sleep is both
 * flaky and dangerous here, because a run that produces only one frame can
 * never clear and would pass vacuously. The last case is a control that renders
 * a deliberately overflowing frame to prove the assertion has teeth.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render, Box, Text } from 'ink';
import { App } from './App';
import { useCliStore } from '../store';
import type { Message } from '../storage';
import type { AgentStep } from '@bike4mind/agents';

const ROWS = 24;
const COLUMNS = 100;
const ERASE_SCROLLBACK = '\u001b[3J';

class FakeTtyStdout extends EventEmitter {
  isTTY = true;
  writes: string[] = [];

  constructor(
    public columns = COLUMNS,
    public rows = ROWS
  ) {
    super();
  }

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
    // Required, not a nicety: Ink resolves interactive mode as
    // `!isInCi && stdout.isTTY`, and a non-interactive run "disables ANSI erase
    // sequences... writing only the final frame at unmount". Under CI=true these
    // tests would then observe no repaints at all and could never see the erase
    // they exist to forbid. Forcing it keeps them measuring the same path a real
    // terminal takes.
    interactive: true,
  });

/** Waits for Ink to write at least one more frame than it had. */
const nextFrame = async (before: number) => {
  await vi.waitFor(() => expect(stdout.writes.length).toBeGreaterThan(before), { timeout: 10_000, interval: 10 });
};

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

/** Grows the pending trace step by step, the way a real turn does. */
async function runTurn(stepCounts: number[]) {
  for (const count of stepCounts) {
    const before = stdout.writes.length;
    useCliStore.setState({ pendingMessages: [pendingMessage(count)], isThinking: true });
    await nextFrame(before);
  }
}

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

const GROWING_TURN = [1, 5, 10, 20, 40, 80];

describe('App does not clobber scrollback while thinking', () => {
  beforeEach(() => {
    stdout = new FakeTtyStdout();
    stdin = new FakeTtyStdin();
    useCliStore.setState({ pendingMessages: [], isThinking: true, messageQueue: [] });
  });

  afterEach(() => {
    useCliStore.setState({ pendingMessages: [], isThinking: false, messageQueue: [] });
  });

  it('never erases scrollback as the step trace grows', async () => {
    const instance = renderApp();
    await runTurn(GROWING_TURN);
    // Ink clears once at teardown for a frame that filled the viewport; the
    // defect is the wipe on every repaint, so measure the writes made before
    // unmount.
    const duringRun = stdout.all;
    instance.unmount();

    expect(stdout.writes.length).toBeGreaterThan(GROWING_TURN.length);
    expect(duringRun).not.toContain(ERASE_SCROLLBACK);
  });

  it('never erases scrollback on a short terminal', async () => {
    stdout.rows = 12;

    const instance = renderApp();
    await runTurn(GROWING_TURN);
    const duringRun = stdout.all;
    instance.unmount();

    expect(duringRun).not.toContain(ERASE_SCROLLBACK);
  });

  it('never erases scrollback on a narrow terminal', async () => {
    stdout.columns = 40;

    const instance = renderApp();
    await runTurn(GROWING_TURN);
    const duringRun = stdout.all;
    instance.unmount();

    expect(duringRun).not.toContain(ERASE_SCROLLBACK);
  });

  it('never erases scrollback with queued messages taking rows', async () => {
    useCliStore.setState({ messageQueue: ['first queued message', 'second queued message'] });

    const instance = renderApp();
    await runTurn(GROWING_TURN);
    const duringRun = stdout.all;
    instance.unmount();

    expect(duringRun).not.toContain(ERASE_SCROLLBACK);
  });

  it('control: an overflowing live frame does erase scrollback', async () => {
    const Overflowing = ({ rows }: { rows: number }) => (
      <Box flexDirection="column">
        {Array.from({ length: rows }, (_, i) => (
          <Text key={i}>{`row ${i}`}</Text>
        ))}
      </Box>
    );

    const instance = renderWithFakeTty(<Overflowing rows={ROWS * 2} />);
    // A second overflowing frame is what triggers the clear - the first has no
    // previous frame to erase.
    const before = stdout.writes.length;
    instance.rerender(<Overflowing rows={ROWS * 2 + 1} />);
    await nextFrame(before);
    instance.unmount();

    expect(stdout.all).toContain(ERASE_SCROLLBACK);
  });
});
