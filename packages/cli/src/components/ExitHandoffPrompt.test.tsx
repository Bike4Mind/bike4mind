import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ExitHandoffPrompt } from './ExitHandoffPrompt';

describe('ExitHandoffPrompt', () => {
  it('renders the y/n prompt', () => {
    const { lastFrame } = render(<ExitHandoffPrompt onResponse={() => {}} />);
    expect(lastFrame()).toContain('Generate a handoff');
    expect(lastFrame()).toContain('(Y/n)');
  });

  it('invokes onResponse(true) when "y" is pressed', () => {
    const onResponse = vi.fn();
    const { stdin } = render(<ExitHandoffPrompt onResponse={onResponse} />);
    stdin.write('y');
    expect(onResponse).toHaveBeenCalledWith(true);
  });

  it('invokes onResponse(true) when Enter is pressed', () => {
    const onResponse = vi.fn();
    const { stdin } = render(<ExitHandoffPrompt onResponse={onResponse} />);
    stdin.write('\r');
    expect(onResponse).toHaveBeenCalledWith(true);
  });

  it('invokes onResponse(false) when "n" is pressed', () => {
    const onResponse = vi.fn();
    const { stdin } = render(<ExitHandoffPrompt onResponse={onResponse} />);
    stdin.write('n');
    expect(onResponse).toHaveBeenCalledWith(false);
  });

  it('ignores further input after responding (single-shot guard)', () => {
    const onResponse = vi.fn();
    const { stdin } = render(<ExitHandoffPrompt onResponse={onResponse} />);
    stdin.write('y');
    stdin.write('n');
    stdin.write('y');
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledWith(true);
  });
});
