/**
 * The live (non-<Static>) frame must stay shorter than the terminal viewport:
 * Ink falls back to clearTerminal - which erases scrollback - for every frame
 * that overflows, so a growing step trace makes it impossible to scroll up
 * while the agent is thinking.
 *
 * liveStepWindow.test.ts pins the selection logic against its row model - two
 * rows per step, three for an action with a result. That model is only exact
 * because this component truncates every live line and collapses whitespace, so
 * these tests render through real Ink and pin the rendering side of that
 * contract at widths narrow enough to break it.
 *
 * Note: ink-testing-library hardcodes a 100-column stdout and ignores any
 * columns option, so the width sweep drives Ink's own render() against a fake
 * stream we control instead. Rendering through ink-testing-library would silently
 * measure every case at 100 columns.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import { MessageItem } from './MessageItem';
import type { Message } from '../storage';
import type { AgentStep } from '@bike4mind/agents';

const ROWS = 24;

class FakeStdout extends EventEmitter {
  isTTY = false;
  writes: string[] = [];

  constructor(
    public columns: number,
    public rows: number = ROWS
  ) {
    super();
  }

  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }
}

let activeStdout = new FakeStdout(100);

vi.mock('ink', async importOriginal => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({ stdout: activeStdout, write: () => {} }),
  };
});

// eslint-disable-next-line no-control-regex
const stripAnsi = (value: string) => value.replace(/\[[0-9;]*[A-Za-z]/g, '');

/**
 * Renders through real Ink at an exact terminal width and returns the height of
 * the frame Ink actually wrote.
 */
function renderedHeight(node: React.ReactElement, columns: number): number {
  activeStdout = new FakeStdout(columns);
  const instance = render(node, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout: activeStdout as any, // any: fake stream, only the bits Ink touches
    patchConsole: false,
    exitOnCtrlC: false,
  });
  instance.unmount();

  const frame = activeStdout.writes.join('');
  return stripAnsi(frame).replace(/\n+$/, '').split('\n').length;
}

const thoughtStep = (i: number): AgentStep => ({
  type: 'thought',
  content: `considering option ${i} in some detail`,
  metadata: { timestamp: 0 },
});

const pendingMessage = (steps: AgentStep[]): Message => ({
  id: 'pending-1',
  role: 'assistant',
  content: '...',
  timestamp: new Date(0).toISOString(),
  metadata: { steps },
});

const manyThoughts = Array.from({ length: 60 }, (_, i) => thoughtStep(i));

const frameText = (node: React.ReactElement, columns: number): string => {
  activeStdout = new FakeStdout(columns);
  const instance = render(node, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout: activeStdout as any, // any: fake stream, only the bits Ink touches
    patchConsole: false,
    exitOnCtrlC: false,
  });
  instance.unmount();
  return stripAnsi(activeStdout.writes.join(''));
};

afterEach(() => {
  activeStdout = new FakeStdout(100);
});

describe('MessageItem live trace', () => {
  it('keeps a long trace within the row budget', () => {
    expect(
      renderedHeight(<MessageItem message={pendingMessage(manyThoughts)} liveTraceRows={12} />, 100)
    ).toBeLessThanOrEqual(12);
  });

  it('shows the newest steps, not the oldest', () => {
    const text = frameText(<MessageItem message={pendingMessage(manyThoughts)} liveTraceRows={12} />, 100);

    expect(text).toContain('option 59');
    expect(text).not.toContain('option 0 ');
  });

  it('says how many steps are hidden', () => {
    const text = frameText(<MessageItem message={pendingMessage(manyThoughts)} liveTraceRows={12} />, 100);

    expect(text).toMatch(/\.\.\. \d+ earlier steps hidden/);
  });

  it('renders the complete trace when no budget is given (<Static> history)', () => {
    const text = frameText(<MessageItem message={pendingMessage(manyThoughts)} />, 100);

    expect(text).toContain('option 0 ');
    expect(text).toContain('option 59');
    expect(renderedHeight(<MessageItem message={pendingMessage(manyThoughts)} />, 100)).toBeGreaterThan(ROWS);
  });
});

/**
 * Sweep of trace shapes chosen to break a fixed rows-per-step model: text that
 * wraps on word boundaries, words wider than the terminal, embedded newlines,
 * long unbroken paths, results that dwarf their action, and budgets too small to
 * fit even one step.
 */
describe('MessageItem live trace height bound', () => {
  const shapes: Record<string, AgentStep[]> = {
    'short thoughts': manyThoughts,
    'word-wrapping thoughts': Array.from({ length: 12 }, (_, i) => ({
      type: 'thought' as const,
      content: `${i} ` + 'deliberation '.repeat(40),
      metadata: { timestamp: 0 },
    })),
    // Words just over half the wrap width are the worst case for greedy word
    // wrap: one word per line, where chars/width predicts two.
    'half-width words': Array.from({ length: 12 }, (_, i) => ({
      type: 'thought' as const,
      content: `${i} ` + `${'a'.repeat(38)} `.repeat(12),
      metadata: { timestamp: 0 },
    })),
    'one huge thought': [{ type: 'thought' as const, content: 'x'.repeat(20_000), metadata: { timestamp: 0 } }],
    // Truncation alone does not bound these - embedded newlines still start new
    // rows - so the live path has to collapse whitespace as well.
    'thoughts with newlines': Array.from({ length: 12 }, (_, i) => ({
      type: 'thought' as const,
      content: `plan ${i}:\nfirst do this\nthen that\nthen the other thing`,
      metadata: { timestamp: 0 },
    })),
    'results with newlines': Array.from({ length: 12 }, (_, i) => [
      {
        type: 'action' as const,
        content: 'bash_execute',
        metadata: { timestamp: 0, toolName: 'bash_execute', toolInput: { command: `ls /dir${i}` } },
      },
      {
        type: 'observation' as const,
        content: `one.txt\ntwo.txt\nthree.txt\nfour.txt\nfive.txt`,
        metadata: { timestamp: 0 },
      },
    ]).flat(),
    'actions with long paths': Array.from({ length: 16 }, (_, i) => [
      {
        type: 'action' as const,
        content: 'read_local_file',
        metadata: {
          timestamp: 0,
          toolName: 'read_local_file',
          toolInput: { path: `/Users/someone/work/repo/packages/cli/src/components/SomeFairlyLongName${i}.tsx` },
        },
      },
      {
        type: 'observation' as const,
        content: `Read SomeFairlyLongName${i}.tsx (240 lines) ` + 'and more detail '.repeat(20),
        metadata: { timestamp: 0 },
      },
    ]).flat(),
    'actions still running': Array.from({ length: 16 }, (_, i) => ({
      type: 'action' as const,
      content: 'bash_execute',
      metadata: { timestamp: 0, toolName: 'bash_execute', toolInput: { command: `pnpm --filter pkg-${i} test` } },
    })),
  };

  for (const [name, steps] of Object.entries(shapes)) {
    for (const columns of [40, 80, 120]) {
      it(`renders within the budget: ${name} at ${columns} cols`, () => {
        for (const budget of [0, 1, 2, 3, 5, 8, 12, 20]) {
          const height = renderedHeight(
            <MessageItem message={pendingMessage(steps)} liveTraceRows={budget} />,
            columns
          );
          // An empty render still reports one (blank) line.
          expect(height, `${name} at ${columns} cols with budget ${budget}`).toBeLessThanOrEqual(Math.max(1, budget));
        }
      });
    }
  }
});
