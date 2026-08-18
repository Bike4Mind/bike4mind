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

  constructor(columns: number | undefined, rows: number | undefined) {
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

let fakeStdout: FakeStdout | undefined;

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

    // Ink throttles renders, so poll rather than sleeping a fixed interval.
    fakeStdout!.resize(60, 20);
    await vi.waitFor(() => expect(lastFrame()).toBe('60x20'));

    fakeStdout!.resize(200, 50);
    await vi.waitFor(() => expect(lastFrame()).toBe('200x50'));
  });

  it('falls back to 80x24 when stdout reports no dimensions', () => {
    fakeStdout = new FakeStdout(undefined, undefined);
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toBe('80x24');
  });

  it('falls back to 80x24 when there is no stdout at all', () => {
    fakeStdout = undefined;
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toBe('80x24');
  });

  it('detaches its resize listener on unmount', () => {
    const { unmount } = render(<Probe />);
    expect(fakeStdout!.listenerCount('resize')).toBe(1);
    unmount();
    expect(fakeStdout!.listenerCount('resize')).toBe(0);
  });

  // <Static> bulk-mounts every message on its first render, so one listener per
  // consumer would trip Node's maxListeners=10 warning on a resumed session.
  it('attaches a single resize listener no matter how many consumers mount', async () => {
    const many = Array.from({ length: 15 }, (_, i) => <Probe key={i} />);
    const { lastFrame, unmount } = render(<>{many}</>);

    expect(fakeStdout!.listenerCount('resize')).toBe(1);

    fakeStdout!.resize(60, 20);
    await vi.waitFor(() => expect(lastFrame()).toBe(Array(15).fill('60x20').join('\n')));

    unmount();
    expect(fakeStdout!.listenerCount('resize')).toBe(0);
  });

  it('picks up a resize that happened while no consumer was subscribed', () => {
    const first = render(<Probe />);
    expect(first.lastFrame()).toBe('120x40');
    first.unmount();

    fakeStdout!.resize(90, 30);

    const second = render(<Probe />);
    expect(second.lastFrame()).toBe('90x30');
  });
});
