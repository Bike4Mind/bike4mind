import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { FolderTrustPrompt } from './FolderTrustPrompt';

const tick = () => new Promise(resolve => setTimeout(resolve, 60));

// ESC [ B (down arrow), built at runtime so the source file stays ASCII (a raw
// ESC byte would trip the control-byte guard and make the file read as binary).
const ARROW_DOWN = String.fromCharCode(27) + '[B';
const ENTER = '\r';

describe('FolderTrustPrompt', () => {
  it('shows the project root and both trust choices', () => {
    const { lastFrame } = render(<FolderTrustPrompt projectRoot="/home/me/repo" onSelect={() => {}} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/home/me/repo');
    expect(frame).toContain('Trust this folder');
    expect(frame).toContain('Not now');
  });

  it('selects trust when Enter is pressed on the default (first) item', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<FolderTrustPrompt projectRoot="/r" onSelect={onSelect} />);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith('trust');
  });

  it('selects not-now after moving down then pressing Enter', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<FolderTrustPrompt projectRoot="/r" onSelect={onSelect} />);
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith('not-now');
  });
});
