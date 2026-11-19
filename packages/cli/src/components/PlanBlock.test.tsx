import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { PlanBlock } from './PlanBlock';
import { useCliStore } from '../store';
import { fromCliTodos } from '@bike4mind/common';

const plan = fromCliTodos([
  { content: 'Write schema', status: 'completed' },
  { content: 'Wire tool', activeForm: 'Wiring tool', status: 'in_progress' },
  { content: 'Add tests', status: 'pending' },
  { content: 'Drop docs', status: 'cancelled' },
]).plan.items;

describe('PlanBlock', () => {
  beforeEach(() => {
    useCliStore.setState({ plan: [], isThinking: false, turnInFlight: false });
  });

  it('renders nothing for an empty plan', () => {
    const { lastFrame } = render(<PlanBlock />);
    expect(lastFrame()).toBe('');
  });

  it('expands every item while a turn is running, using activeForm for the current one', () => {
    useCliStore.setState({ plan, turnInFlight: true });
    const frame = render(<PlanBlock />).lastFrame() ?? '';
    expect(frame).toContain('\u2714 Write schema');
    expect(frame).toContain('\u25B6 Wiring tool');
    expect(frame).not.toContain('Wire tool');
    expect(frame).toContain('\u25CB Add tests');
    expect(frame).toContain('\u2715 Drop docs');
  });

  it('collapses to n/m - current when the turn ends', () => {
    useCliStore.setState({ plan });
    expect(render(<PlanBlock />).lastFrame()).toBe('1/3 - Wiring tool');
  });

  it('collapses to n/m when nothing is in progress', () => {
    useCliStore.setState({ plan: [{ ...plan[0] }] });
    expect(render(<PlanBlock />).lastFrame()).toBe('1/1');
  });
});
