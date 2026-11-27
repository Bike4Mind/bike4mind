import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useSessionLayout, { type ArtifactData } from '@client/app/hooks/useSessionLayout';
import type { TutorialStepProps } from '../types';
import { ArtifactOpenStep } from './ArtifactOpenStep';

const flyer: ArtifactData = { type: 'html', content: '<p>flyer</p>', mimeType: 'text/html', id: 'artifact-1' };

function stepProps(complete: () => void): TutorialStepProps {
  return {
    step: { id: 'artifacts-open', type: 'artifact-open', title: 'Open it', body: 'Open it.' },
    sessionId: 'session-1',
    quests: [],
    complete,
    advance: vi.fn(async () => undefined),
    setAnchor: vi.fn(),
    sheetFileId: vi.fn(async () => 'file-1'),
  };
}

describe('ArtifactOpenStep', () => {
  const initial = useSessionLayout.getState();

  beforeEach(() => {
    useSessionLayout.setState({ layout: 'hide', artifactData: undefined });
  });

  afterEach(() => {
    useSessionLayout.setState(initial, true);
  });

  it('completes when the user opens an artifact beside the chat', () => {
    const complete = vi.fn();
    render(<ArtifactOpenStep {...stepProps(complete)} />);

    act(() => useSessionLayout.setState({ layout: 'vertical', artifactData: flyer }));

    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not complete on a viewer that was already open when the step began', () => {
    useSessionLayout.setState({ layout: 'vertical', artifactData: flyer });
    const complete = vi.fn();
    render(<ArtifactOpenStep {...stepProps(complete)} />);

    act(() => useSessionLayout.setState({ layout: 'horizontal' }));

    expect(complete).not.toHaveBeenCalled();
  });

  it('does not complete while the viewer stays hidden', () => {
    const complete = vi.fn();
    render(<ArtifactOpenStep {...stepProps(complete)} />);

    act(() => useSessionLayout.setState({ artifactData: flyer }));

    expect(complete).not.toHaveBeenCalled();
  });

  it('stops listening once the step is gone', () => {
    const complete = vi.fn();
    const { unmount } = render(<ArtifactOpenStep {...stepProps(complete)} />);
    unmount();

    act(() => useSessionLayout.setState({ layout: 'vertical', artifactData: flyer }));

    expect(complete).not.toHaveBeenCalled();
  });

  it('calls the latest complete after a re-render', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<ArtifactOpenStep {...stepProps(first)} />);
    rerender(<ArtifactOpenStep {...stepProps(latest)} />);

    act(() => useSessionLayout.setState({ layout: 'vertical', artifactData: flyer }));

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});
