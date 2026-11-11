import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { JourneyPanel, type JourneyModule } from './JourneyPanel';

const steps = [
  { id: 'intro', type: 'point', body: 'b', title: 'Start' },
  { id: 'ask', type: 'prompt', body: 'b', turn: 1, action: 'Ask it' },
  { id: 'wrap', type: 'point', body: 'b', title: 'Wrap up' },
  { id: 'bridge', type: 'bridge', body: 'b' },
];

const status = (moduleId: string, stepId: string) =>
  screen.getByTestId(`journey-step-${moduleId}-${stepId}`).getAttribute('data-status');

function renderPanel(modules: JourneyModule[], onJump = vi.fn()) {
  render(<JourneyPanel open onClose={() => undefined} modules={modules} onJump={onJump} />);
  return onJump;
}

describe('JourneyPanel', () => {
  it('places every step against where the module stands', () => {
    renderPanel([
      { id: 'one', title: 'One', steps, currentStepId: 'ask' },
      { id: 'two', title: 'Two', steps },
      { id: 'three', title: 'Three', steps, currentStepId: 'wrap', finished: true },
    ]);
    fireEvent.click(screen.getByTestId('journey-module-two'));
    fireEvent.click(screen.getByTestId('journey-module-three'));
    expect(['intro', 'ask', 'wrap'].map(id => status('one', id))).toEqual(['done', 'current', 'ahead']);
    expect(['intro', 'ask', 'wrap'].map(id => status('two', id))).toEqual(['ahead', 'ahead', 'ahead']);
    expect(['intro', 'ask', 'wrap'].map(id => status('three', id))).toEqual(['done', 'done', 'done']);
  });

  it('opens on the running module, with the others folded and their standing beside the title', () => {
    renderPanel([
      { id: 'one', title: 'One', steps, finished: true },
      { id: 'two', title: 'Two', steps, currentStepId: 'ask', active: true },
      { id: 'three', title: 'Three', steps },
    ]);
    expect(screen.getByTestId('journey-step-two-ask')).toBeInTheDocument();
    expect(screen.getByTestId('journey-module-two')).toHaveTextContent('Step 2 of 3');
    expect(screen.getByTestId('journey-module-one')).toHaveTextContent('Finished');
    expect(screen.queryByTestId('journey-step-one-intro')).toBeNull();
    expect(screen.queryByTestId('journey-step-three-intro')).toBeNull();
    fireEvent.click(screen.getByTestId('journey-module-two'));
    expect(screen.queryByTestId('journey-step-two-ask')).toBeNull();
    fireEvent.click(screen.getByTestId('journey-module-three'));
    expect(status('three', 'intro')).toBe('ahead');
  });

  it('opens on a module in progress when none is running, else on the first not finished', () => {
    const { unmount } = render(
      <JourneyPanel
        open
        onClose={() => undefined}
        onJump={vi.fn()}
        modules={[
          { id: 'one', title: 'One', steps },
          { id: 'two', title: 'Two', steps, currentStepId: 'ask' },
        ]}
      />
    );
    expect(screen.getByTestId('journey-step-two-intro')).toBeInTheDocument();
    expect(screen.queryByTestId('journey-step-one-intro')).toBeNull();
    unmount();
    renderPanel([
      { id: 'one', title: 'One', steps, finished: true },
      { id: 'two', title: 'Two', steps },
    ]);
    expect(screen.getByTestId('journey-step-two-intro')).toBeInTheDocument();
  });

  it('shows a module left part way as stopped there, with no step marked as where the user is', () => {
    renderPanel([{ id: 'one', title: 'One', steps, currentStepId: 'ask', stopped: true }]);
    expect(screen.getByTestId('journey-module-one')).toHaveTextContent('Stopped at step 2 of 3');
    expect(['intro', 'ask', 'wrap'].map(id => status('one', id))).toEqual(['done', 'ahead', 'ahead']);
    expect(screen.queryByText('You are here')).toBeNull();
  });

  it("forgets the user's own folding when the panel closes, and opens on the default again", () => {
    const modules: JourneyModule[] = [
      { id: 'one', title: 'One', steps },
      { id: 'two', title: 'Two', steps, currentStepId: 'ask', active: true },
    ];
    const panel = (open: boolean) => (
      <JourneyPanel open={open} onClose={() => undefined} onJump={vi.fn()} modules={modules} />
    );
    const { rerender } = render(panel(true));
    fireEvent.click(screen.getByTestId('journey-module-two'));
    fireEvent.click(screen.getByTestId('journey-module-one'));
    expect(screen.queryByTestId('journey-step-two-intro')).toBeNull();
    expect(screen.getByTestId('journey-step-one-intro')).toBeInTheDocument();
    rerender(panel(false));
    rerender(panel(true));
    expect(screen.getByTestId('journey-step-two-intro')).toBeInTheDocument();
    expect(screen.queryByTestId('journey-step-one-intro')).toBeNull();
  });

  it('labels a step by its title, else its button, and leaves the bridge out', () => {
    renderPanel([{ id: 'one', title: 'One', steps }]);
    expect(screen.getByTestId('journey-step-one-intro')).toHaveTextContent('Start');
    expect(screen.getByTestId('journey-step-one-ask')).toHaveTextContent('Ask it');
    expect(screen.queryByTestId('journey-step-one-bridge')).toBeNull();
  });

  it('jumps to any step, back or ahead', () => {
    const onJump = renderPanel([{ id: 'one', title: 'One', steps, currentStepId: 'ask' }]);
    fireEvent.click(screen.getByTestId('journey-step-one-intro'));
    fireEvent.click(screen.getByTestId('journey-step-one-wrap'));
    expect(onJump.mock.calls).toEqual([
      ['one', 'intro'],
      ['one', 'wrap'],
    ]);
  });

  it('offers Start on a module never begun, and Start over on one begun or started', () => {
    const onRestart = vi.fn();
    render(
      <JourneyPanel
        open
        onClose={() => undefined}
        modules={[
          { id: 'one', title: 'One', steps, currentStepId: 'ask' },
          { id: 'two', title: 'Two', steps },
          { id: 'three', title: 'Three', steps, finished: true },
          { id: 'four', title: 'Four', steps, resumable: true },
        ]}
        onJump={vi.fn()}
        onRestart={onRestart}
      />
    );
    expect(screen.queryByTestId('journey-restart-two')).toBeNull();
    expect(screen.queryByTestId('journey-start-one')).toBeNull();
    expect(screen.queryByTestId('journey-start-four')).toBeNull();
    fireEvent.click(screen.getByTestId('journey-restart-one'));
    fireEvent.click(screen.getByTestId('journey-start-two'));
    fireEvent.click(screen.getByTestId('journey-restart-three'));
    fireEvent.click(screen.getByTestId('journey-restart-four'));
    expect(onRestart.mock.calls).toEqual([['one'], ['two'], ['three'], ['four']]);
  });

  it('offers Resume on every resumable module, the running one included', () => {
    const onResume = vi.fn();
    render(
      <JourneyPanel
        open
        onClose={() => undefined}
        modules={[
          { id: 'one', title: 'One', steps, currentStepId: 'ask', resumable: true },
          { id: 'two', title: 'Two', steps, currentStepId: 'ask', resumable: true, active: true },
          { id: 'three', title: 'Three', steps, currentStepId: 'ask' },
          { id: 'four', title: 'Four', steps },
          { id: 'five', title: 'Five', steps, currentStepId: 'ask', active: true },
        ]}
        onJump={vi.fn()}
        onResume={onResume}
      />
    );
    for (const id of ['three', 'four', 'five']) expect(screen.queryByTestId(`journey-resume-${id}`)).toBeNull();
    fireEvent.click(screen.getByTestId('journey-resume-one'));
    fireEvent.click(screen.getByTestId('journey-resume-two'));
    expect(onResume.mock.calls).toEqual([['one'], ['two']]);
  });
});
