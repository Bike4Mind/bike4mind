// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatProject } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ProjectSubtitleLine } from './ProjectSubtitleLine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const WORKTREE = '/Users/someone/dev/repo/.b4m/worktrees/b4m+feat-abc';
const PROJECT: ChatProject = {
  directory: '/Users/someone/dev/repo',
  name: 'repo',
  branch: 'main',
  workspace: true,
  workspaceBranch: 'b4m/feat-abc',
  workingDirectory: WORKTREE,
  contextDirectories: [],
};

const writeText = vi.fn<(text: string) => Promise<void>>();
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  // jsdom has no clipboard.
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ProjectSubtitleLine project={PROJECT} />
      </CssVarsProvider>
    );
  });
  return host.querySelector<HTMLElement>('[data-testid="chat-project-cwd"]')!;
}

describe('ProjectSubtitleLine', () => {
  it('shows project and branch rather than the path', async () => {
    const line = await mount();
    expect(line.textContent).toBe('repo \u00B7 b4m/feat-abc');
    expect(line.getAttribute('aria-label')).toContain(WORKTREE);
  });

  it('copies the full path on click and confirms briefly', async () => {
    vi.useFakeTimers();
    const line = await mount();
    await act(async () => line.click());
    expect(writeText).toHaveBeenCalledWith(WORKTREE);
    expect(line.dataset.copyState).toBe('copied');
    await act(async () => vi.advanceTimersByTime(2000));
    expect(line.dataset.copyState).toBe('idle');
  });

  it('says so when the clipboard refuses', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeText.mockRejectedValue(new Error('denied'));
    const line = await mount();
    await act(async () => line.click());
    expect(line.dataset.copyState).toBe('failed');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
