/**
 * Queued-message rows are padded to the terminal width so their background
 * colour fills the row; these tests pin that the padding recomputes on resize,
 * which is the behaviour #644 was filed for.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from './App';
import { useCliStore } from '../store';

class FakeStdout extends EventEmitter {
  columns: number | undefined;
  rows: number | undefined;

  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  resize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

let fakeStdout: FakeStdout;

// Ink trims trailing whitespace off every rendered line unless the padding
// carries colour codes, so the row padding is only observable with colour on.
vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});

vi.mock('ink', async importOriginal => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({ stdout: fakeStdout, write: () => {} }),
  };
});

// eslint-disable-next-line no-control-regex
const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '');

const queuedRowWidth = (frame: string | undefined) =>
  stripAnsi(frame ?? '')
    .split('\n')
    .find(line => line.includes('queued message'))
    ?.trimStart().length;

const noop = () => {};
const asyncNoop = async () => {};

function renderApp() {
  return render(
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

describe('App queued-row padding on resize', () => {
  beforeEach(() => {
    fakeStdout = new FakeStdout(60, 20);
    useCliStore.setState({ messageQueue: ['a queued message'] });
  });

  afterEach(() => {
    useCliStore.setState({ messageQueue: [] });
  });

  it('pads queued rows to the current terminal width', () => {
    const { lastFrame, unmount } = renderApp();
    // paddingX={1} on the wrapper, so the row itself is two columns narrower.
    expect(queuedRowWidth(lastFrame())).toBe(58);
    unmount();
  });

  it('re-pads queued rows when the terminal is resized', async () => {
    const { lastFrame, unmount } = renderApp();
    expect(queuedRowWidth(lastFrame())).toBe(58);

    fakeStdout.resize(40, 20);
    await vi.waitFor(() => expect(queuedRowWidth(lastFrame())).toBe(38));

    fakeStdout.resize(100, 20);
    await vi.waitFor(() => expect(queuedRowWidth(lastFrame())).toBe(98));
    unmount();
  });
});
