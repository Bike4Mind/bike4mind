import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { StatusBar } from './StatusBar';
import { useCliStore } from '../store';

describe('StatusBar', () => {
  beforeEach(() => {
    useCliStore.setState({ interactionMode: 'normal' });
  });

  it('should show no mode indicator in normal mode', () => {
    const { lastFrame } = render(<StatusBar isBashMode={false} model="claude" tokenUsage={100} />);

    expect(lastFrame()).not.toContain('AUTO ACCEPT');
    expect(lastFrame()).not.toContain('PLAN MODE');
  });

  it('should show auto-accept indicator in auto-accept mode', () => {
    useCliStore.setState({ interactionMode: 'auto-accept' });

    const { lastFrame } = render(<StatusBar isBashMode={false} model="claude" tokenUsage={100} />);

    expect(lastFrame()).toContain('AUTO ACCEPT: Edits');
    expect(lastFrame()).not.toContain('PLAN MODE');
  });

  it('should show plan-mode indicator in plan mode', () => {
    useCliStore.setState({ interactionMode: 'plan' });

    const { lastFrame } = render(<StatusBar isBashMode={false} model="claude" tokenUsage={100} />);

    expect(lastFrame()).toContain('PLAN MODE');
    expect(lastFrame()).not.toContain('AUTO ACCEPT');
  });

  it('should show BASH badge when bash mode is active', () => {
    const { lastFrame } = render(<StatusBar isBashMode={true} model="claude" tokenUsage={100} />);

    expect(lastFrame()).toContain('BASH');
  });

  it('should not show BASH badge when bash mode is inactive', () => {
    const { lastFrame } = render(<StatusBar isBashMode={false} model="claude" tokenUsage={100} />);

    expect(lastFrame()).not.toContain('BASH');
  });

  it('should show the subagent token segment when subagentTokenUsage > 0', () => {
    const { lastFrame } = render(
      <StatusBar isBashMode={false} model="claude" tokenUsage={100} subagentTokenUsage={250} />
    );

    expect(lastFrame()).toContain('+250 agent tokens');
  });

  it('should hide the subagent token segment when subagentTokenUsage is 0 or undefined', () => {
    const { lastFrame: zeroFrame } = render(
      <StatusBar isBashMode={false} model="claude" tokenUsage={100} subagentTokenUsage={0} />
    );
    expect(zeroFrame()).not.toContain('agent tokens');

    const { lastFrame: undefinedFrame } = render(<StatusBar isBashMode={false} model="claude" tokenUsage={100} />);
    expect(undefinedFrame()).not.toContain('agent tokens');
  });

  it('should show the subagent credits segment when subagentCreditsUsage > 0', () => {
    const { lastFrame } = render(
      <StatusBar isBashMode={false} model="claude" tokenUsage={100} subagentCreditsUsage={4} />
    );

    expect(lastFrame()).toContain('+4 agent credits');
  });

  it('should hide the subagent credits segment when subagentCreditsUsage is 0 or undefined', () => {
    const { lastFrame: zeroFrame } = render(
      <StatusBar isBashMode={false} model="claude" tokenUsage={100} subagentCreditsUsage={0} />
    );
    expect(zeroFrame()).not.toContain('agent credits');

    const { lastFrame: undefinedFrame } = render(<StatusBar isBashMode={false} model="claude" tokenUsage={100} />);
    expect(undefinedFrame()).not.toContain('agent credits');
  });

  it('should not affect the main token/credit segments', () => {
    const { lastFrame } = render(
      <StatusBar
        isBashMode={false}
        model="claude"
        tokenUsage={100}
        creditsUsage={9}
        subagentTokenUsage={250}
        subagentCreditsUsage={4}
      />
    );

    expect(lastFrame()).toContain('100 tokens');
    expect(lastFrame()).toContain('9 credits');
    expect(lastFrame()).toContain('+250 agent tokens');
    expect(lastFrame()).toContain('+4 agent credits');
  });
});
