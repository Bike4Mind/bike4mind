/**
 * The live (non-<Static>) frame must stay shorter than the terminal viewport:
 * Ink falls back to clearTerminal - which erases scrollback - for every frame
 * that overflows, so a growing step trace makes it impossible to scroll up
 * while the agent is thinking. These tests pin the bound on the trace height.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { MessageItem } from './MessageItem';
import type { Message } from '../storage';
import type { AgentStep } from '@bike4mind/agents';

// ink-testing-library renders at 100 columns; match it so the wrap estimate in
// liveStepWindow lines up with what Ink actually prints.
const COLUMNS = 100;
const ROWS = 24;

class FakeStdout extends EventEmitter {
  columns: number | undefined = COLUMNS;
  rows: number | undefined = ROWS;
}

const fakeStdout = new FakeStdout();

vi.mock('ink', async importOriginal => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({ stdout: fakeStdout, write: () => {} }),
  };
});

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

const frameHeight = (frame: string | undefined) => (frame ?? '').split('\n').length;

describe('MessageItem live trace', () => {
  it('keeps a long trace within the row budget', () => {
    const message = pendingMessage(Array.from({ length: 60 }, (_, i) => thoughtStep(i)));

    const { lastFrame } = render(<MessageItem message={message} liveTraceRows={12} />);

    expect(frameHeight(lastFrame())).toBeLessThanOrEqual(12);
    // The newest step is the one that stays visible.
    expect(lastFrame()).toContain('option 59');
    expect(lastFrame()).not.toContain('option 0 ');
  });

  it('tells the user the earlier steps are not lost', () => {
    const message = pendingMessage(Array.from({ length: 60 }, (_, i) => thoughtStep(i)));

    const { lastFrame } = render(<MessageItem message={message} liveTraceRows={12} />);

    expect(lastFrame()).toMatch(/\.\.\. \d+ earlier steps - full trace prints when the turn ends/);
  });

  it('stays bounded even when a single thought is longer than the viewport', () => {
    const message = pendingMessage([{ type: 'thought', content: 'x'.repeat(20_000), metadata: { timestamp: 0 } }]);

    const { lastFrame } = render(<MessageItem message={message} liveTraceRows={12} />);

    expect(frameHeight(lastFrame())).toBeLessThanOrEqual(12);
  });

  it('renders the complete trace when no budget is given (<Static> history)', () => {
    const message = pendingMessage(Array.from({ length: 60 }, (_, i) => thoughtStep(i)));

    const { lastFrame } = render(<MessageItem message={message} />);

    expect(lastFrame()).toContain('option 0 ');
    expect(lastFrame()).toContain('option 59');
    expect(frameHeight(lastFrame())).toBeGreaterThan(ROWS);
  });
});
