// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeRemoval } from '@shared/worktreeRemoval';
import { desktopTheme } from '../theme';
import { DeleteSessionDialog } from './DeleteSessionDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

let root: Root | undefined;
let host: HTMLElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host.remove();
});
const element = (id: string) => {
  const found = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
};
const checkbox = () => element('delete-session-worktree-checkbox').querySelector('input')!;
const safe: WorktreeRemoval = { path: '/repo/.b4m/worktrees/test', branch: 'b4m/test', safe: true, reason: null };

async function mount(inspection: WorktreeRemoval | null, onDelete = vi.fn(async () => {})) {
  const onClose = vi.fn();
  (window as unknown as { b4m: unknown }).b4m = { chat: { inspectWorktreeRemoval: vi.fn(async () => inspection) } };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <DeleteSessionDialog sessionId="session" onDelete={onDelete} onClose={onClose} />
      </CssVarsProvider>
    )
  );
  return { onDelete, onClose };
}

describe('DeleteSessionDialog', () => {
  it('defaults cleanup on only for a safe owned worktree and submits the choice', async () => {
    const { onDelete, onClose } = await mount(safe);
    expect(checkbox().checked).toBe(true);
    await act(async () => element('delete-session-confirm-btn').click());
    expect(onDelete).toHaveBeenCalledWith('session', true);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('lets the user keep a safe worktree', async () => {
    const { onDelete } = await mount(safe);
    await act(async () => checkbox().click());
    await act(async () => element('delete-session-confirm-btn').click());
    expect(onDelete).toHaveBeenCalledWith('session', false);
  });
  it.each([
    '3 uncommitted files',
    '2 commits not pushed or merged',
    'Used by another conversation',
    'Conversation is still running',
  ])('keeps unsafe worktrees and displays %s', async reason => {
    const { onDelete } = await mount({ ...safe, safe: false, reason });
    expect(checkbox().checked).toBe(false);
    expect(checkbox().disabled).toBe(true);
    expect(document.body.textContent).toContain(reason);
    await act(async () => element('delete-session-confirm-btn').click());
    expect(onDelete).toHaveBeenCalledWith('session', false);
  });
  it('hides the option for a session without an app worktree', async () => {
    await mount(null);
    expect(document.querySelector('[data-testid="delete-session-worktree-checkbox"]')).toBeNull();
  });
  it('cancels without deleting', async () => {
    const { onDelete, onClose } = await mount(safe);
    await act(async () => element('delete-session-cancel-btn').click());
    expect(onDelete).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('keeps the dialog open and shows git refusals', async () => {
    const { onClose } = await mount(
      safe,
      vi.fn(async () => {
        throw new Error('Worktree is locked');
      })
    );
    await act(async () => element('delete-session-confirm-btn').click());
    expect(element('delete-session-error').textContent).toContain('Worktree is locked');
    expect(onClose).not.toHaveBeenCalled();
    expect(checkbox().checked).toBe(false);
  });
});
