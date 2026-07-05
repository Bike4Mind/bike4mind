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
});
