import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { useStdoutDimensions } from './useStdoutDimensions.js';

// A stdout stand-in with mutable dimensions. Ink's real `useStdout()` exposes a
// stream whose `columns` cannot be changed from a test, so we mock the hook to
// return this and drive `resize` events by hand.
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

vi.mock('ink', async importOriginal => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({ stdout: fakeStdout, write: () => {} }),
  };
});

function Probe() {
  const [columns, rows] = useStdoutDimensions();
  return <Text>{`${columns}x${rows}`}</Text>;
}

describe('useStdoutDimensions', () => {
  beforeEach(() => {
    fakeStdout = new FakeStdout(120, 40);
  });

  it('returns the current terminal dimensions on mount', () => {
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toBe('120x40');
  });

  it('re-renders with new dimensions when the terminal is resized', async () => {
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toBe('120x40');

    // Ink throttles renders, so let the state update flush before asserting.
    const flush = () => new Promise(resolve => setTimeout(resolve, 50));

    fakeStdout.resize(60, 20);
    await flush();
    expect(lastFrame()).toBe('60x20');

    fakeStdout.resize(200, 50);
    await flush();
    expect(lastFrame()).toBe('200x50');
  });

  it('falls back to 80x24 when stdout reports no dimensions', () => {
    fakeStdout = new FakeStdout(undefined as unknown as number, undefined as unknown as number);
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toBe('80x24');
  });

  it('detaches its resize listener on unmount', () => {
    const { unmount } = render(<Probe />);
    expect(fakeStdout.listenerCount('resize')).toBe(1);
    unmount();
    expect(fakeStdout.listenerCount('resize')).toBe(0);
  });
});
