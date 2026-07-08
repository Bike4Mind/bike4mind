import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { BackgroundShellStatus } from './BackgroundShellStatus';
import { useCliStore } from '../store';
import type { ShellSession, ShellSessionStatus } from '@bike4mind/services/llm/tools/cliTools';

function makeSession(overrides: Partial<ShellSession> & { id: string; status: ShellSessionStatus }): ShellSession {
  return {
    command: 'sleep 100',
    cwd: '/tmp',
    exitCode: null,
    startTime: Date.now(),
    totalOutputChars: 0,
    ...overrides,
  };
}

describe('BackgroundShellStatus', () => {
  beforeEach(() => {
    useCliStore.setState({ backgroundShells: [], permissionPrompt: null });
  });

  it('renders nothing when there are no sessions', () => {
    const { lastFrame } = render(<BackgroundShellStatus />);
    expect(lastFrame()).toBe('');
  });

  it('shows the command and elapsed time for a running session', () => {
    useCliStore.setState({
      backgroundShells: [makeSession({ id: 'sh-1', status: 'running', command: 'pnpm dev' })],
    });
    const { lastFrame } = render(<BackgroundShellStatus />);
    expect(lastFrame()).toContain('$ pnpm dev');
  });

  it('shows the exit code for a finished session', () => {
    useCliStore.setState({
      backgroundShells: [
        makeSession({ id: 'sh-2', status: 'exited', command: 'ls', exitCode: 0, endTime: Date.now() }),
      ],
    });
    const { lastFrame } = render(<BackgroundShellStatus />);
    expect(lastFrame()).toContain('$ ls');
    expect(lastFrame()).toContain('exit 0');
  });

  it('shows the status word when killed with no exit code', () => {
    useCliStore.setState({
      backgroundShells: [makeSession({ id: 'sh-3', status: 'killed', command: 'sleep 5', endTime: Date.now() })],
    });
    const { lastFrame } = render(<BackgroundShellStatus />);
    expect(lastFrame()).toContain('killed');
  });

  it('collapses to a static running count while a permission prompt is active', () => {
    useCliStore.setState({
      backgroundShells: [
        makeSession({ id: 'sh-4', status: 'running', command: 'pnpm dev' }),
        makeSession({ id: 'sh-5', status: 'running', command: 'npm run watch' }),
      ],
      // Minimal prompt shape - the component only checks for truthiness.
      permissionPrompt: {
        id: 'p1',
        toolName: 'bash_execute',
        args: {},
        canBeTrusted: false,
        resolve: () => {},
      },
    });
    const { lastFrame } = render(<BackgroundShellStatus />);
    expect(lastFrame()).toContain('2 shells running');
    // No per-command spinner lines while the prompt owns the keyboard.
    expect(lastFrame()).not.toContain('$ pnpm dev');
  });

  it('truncates long commands', () => {
    const longCmd = 'echo ' + 'x'.repeat(100);
    useCliStore.setState({
      backgroundShells: [makeSession({ id: 'sh-6', status: 'running', command: longCmd })],
    });
    const { lastFrame } = render(<BackgroundShellStatus />);
    expect(lastFrame()).toContain('...');
    expect(lastFrame()).not.toContain('x'.repeat(100));
  });
});
