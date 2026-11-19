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
    expect(frame).toContain('\u2713 Write schema');
    expect(frame).toContain('\u25CF Wiring tool');
    expect(frame).not.toContain('Wire tool');
    expect(frame).toContain('\u25CB Add tests');
    expect(frame).toContain('\u2715 Drop docs');
  });

  it('expands while the model is thinking even without a turn in flight', () => {
    useCliStore.setState({ plan, isThinking: true });
    expect(render(<PlanBlock />).lastFrame()).toContain('\u25CF Wiring tool');
  });

  it('collapses to n/m - current content when the turn ends', () => {
    useCliStore.setState({ plan });
    expect(render(<PlanBlock />).lastFrame()).toBe('1/3 - Wire tool');
  });

  it('collapses to the next item when nothing is in progress', () => {
    useCliStore.setState({ plan: [plan[0], plan[2]] });
    expect(render(<PlanBlock />).lastFrame()).toBe('1/2 - Add tests');
  });

  it('hides a finished plan once the turn ends but shows it during the turn', () => {
    useCliStore.setState({ plan: [plan[0], plan[3]] });
    expect(render(<PlanBlock />).lastFrame()).toBe('');
    useCliStore.setState({ turnInFlight: true });
    expect(render(<PlanBlock />).lastFrame()).toContain('Write schema');
  });

  it('caps a long plan to maxRows with a +N more line that keeps the current item', () => {
    const long = fromCliTodos(
      Array.from({ length: 12 }, (_, i) => ({ content: `Task ${i}`, status: i === 7 ? 'in_progress' : 'pending' }))
    ).plan.items;
    useCliStore.setState({ plan: long, turnInFlight: true });
    const frame = render(<PlanBlock maxRows={5} />).lastFrame() ?? '';
    expect(frame.split('\n')).toHaveLength(5);
    expect(frame).toBe(['\u25CB Task 6', '\u25CF Task 7', '\u25CB Task 8', '\u25CB Task 9', '+8 more'].join('\n'));
  });

  it('keeps the in-progress row visible with a one-row window', () => {
    const items = fromCliTodos([
      { content: 'p0', status: 'pending' },
      { content: 'p1', status: 'pending' },
      { content: 'IP', status: 'in_progress' },
      { content: 'p3', status: 'pending' },
    ]).plan.items;
    useCliStore.setState({ plan: items, turnInFlight: true });
    expect(render(<PlanBlock maxRows={2} />).lastFrame()).toBe('\u25CF IP\n+3 more');
  });

  it('windows from the top when nothing is in progress', () => {
    const items = fromCliTodos(Array.from({ length: 6 }, (_, i) => ({ content: `T${i}`, status: 'pending' }))).plan
      .items;
    useCliStore.setState({ plan: items, turnInFlight: true });
    expect(render(<PlanBlock maxRows={3} />).lastFrame()).toBe('\u25CB T0\n\u25CB T1\n+4 more');
  });

  it('collapses a multi-line item to a single row', () => {
    const items = fromCliTodos([{ content: 'line one\nline two\n\nline three', status: 'pending' }]).plan.items;
    useCliStore.setState({ plan: items, turnInFlight: true });
    expect(render(<PlanBlock />).lastFrame()).toBe('\u25CB line one line two line three');
    useCliStore.setState({ turnInFlight: false });
    expect(render(<PlanBlock />).lastFrame()).toBe('0/1 - line one line two line three');
  });

  it('collapsed summary follows planProgress for nested children', () => {
    const cancelledGroup = {
      id: 'b',
      content: 'B',
      status: 'cancelled' as const,
      children: [{ id: 'b1', content: 'B1', status: 'pending' as const }],
    };
    const done = { id: 'a', content: 'A', status: 'completed' as const };
    useCliStore.setState({ plan: [done, cancelledGroup] });
    expect(render(<PlanBlock />).lastFrame()).toBe('');

    const group = {
      id: 'g',
      content: 'Group',
      status: 'in_progress' as const,
      children: [
        { id: 'g1', content: 'Child done', status: 'completed' as const },
        { id: 'g2', content: 'Child active', status: 'in_progress' as const },
      ],
    };
    useCliStore.setState({ plan: [group] });
    expect(render(<PlanBlock />).lastFrame()).toBe('1/2 - Child active');
  });

  it('truncates a long item to one row', () => {
    const items = fromCliTodos([{ content: 'x'.repeat(300), status: 'pending' }]).plan.items;
    useCliStore.setState({ plan: items, turnInFlight: true });
    expect((render(<PlanBlock />).lastFrame() ?? '').split('\n')).toHaveLength(1);
  });
});
