/**
 * The user-prompt highlight is padded to the terminal width so its background
 * colour fills the row; these tests pin that it recomputes on resize, which is
 * the behaviour #644 was filed for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { MessageItem } from './MessageItem';
import { createMockMessage } from '../test-utils/mocks';

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
// carries colour codes, so the highlight's padding is only observable with
// colour forced on.
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

const promptRowWidth = (frame: string | undefined) =>
  stripAnsi(frame ?? '')
    .split('\n')
    .find(line => line.includes('❯'))?.length;

describe('MessageItem prompt padding on resize', () => {
  beforeEach(() => {
    fakeStdout = new FakeStdout(60, 20);
  });

  it('pads the user-prompt row to the current terminal width', () => {
    const message = createMockMessage({ role: 'user', content: 'Hello' });
    const { lastFrame } = render(<MessageItem message={message} />);

    expect(promptRowWidth(lastFrame())).toBe(60);
  });

  it('re-pads the user-prompt row when the terminal is resized', async () => {
    const message = createMockMessage({ role: 'user', content: 'Hello' });
    const { lastFrame } = render(<MessageItem message={message} />);
    expect(promptRowWidth(lastFrame())).toBe(60);

    fakeStdout.resize(30, 20);
    await vi.waitFor(() => expect(promptRowWidth(lastFrame())).toBe(30));

    fakeStdout.resize(100, 20);
    await vi.waitFor(() => expect(promptRowWidth(lastFrame())).toBe(100));
  });
});
