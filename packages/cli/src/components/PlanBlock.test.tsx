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
    expect(frame).toContain('Task 7');
    expect(frame).toContain('+8 more');
  });

  it('truncates a long item to one row', () => {
    const items = fromCliTodos([{ content: 'x'.repeat(300), status: 'pending' }]).plan.items;
    useCliStore.setState({ plan: items, turnInFlight: true });
    expect((render(<PlanBlock />).lastFrame() ?? '').split('\n')).toHaveLength(1);
  });
});
