// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionWorktreeRemoval } from '@shared/worktreeRemoval';
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

// Joy's popups (menus, selects, tooltips, modals) read every ancestor's computed style on each update,
// and jsdom resolves that against every emotion sheet with no layout to find; the inline style will do.
window.getComputedStyle = ((element: Element) => (element as HTMLElement).style) as typeof getComputedStyle;

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
const safe: SessionWorktreeRemoval = {
  path: '/repo/.b4m/worktrees/test',
  branch: 'b4m/test',
  safe: true,
  removable: true,
  reason: null,
};

async function mount(
  inspection: SessionWorktreeRemoval | null,
  onDelete = vi.fn(async () => {}),
  {
    nested = [],
    withNested = inspection,
  }: { nested?: { id: string }[]; withNested?: SessionWorktreeRemoval | null } = {}
) {
  const onClose = vi.fn();
  const inspect = vi.fn(async (_id: string, alsoDeleting?: string[]) => (alsoDeleting ? withNested : inspection));
  (window as unknown as { b4m: unknown }).b4m = { chat: { inspectWorktreeRemoval: inspect } };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <DeleteSessionDialog sessionId="session" title="Parent" nested={nested} onDelete={onDelete} onClose={onClose} />
      </CssVarsProvider>
    )
  );
  return { onDelete, onClose, inspect };
}

describe('DeleteSessionDialog', () => {
  it('defaults cleanup on only for a safe owned worktree and submits the choice', async () => {
    const { onDelete, onClose } = await mount(safe);
    expect(checkbox().checked).toBe(true);
    await act(async () => element('delete-session-confirm-btn').click());
    expect(onDelete).toHaveBeenCalledWith('session', true, undefined);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('lets the user keep a safe worktree', async () => {
    const { onDelete } = await mount(safe);
    await act(async () => checkbox().click());
    await act(async () => element('delete-session-confirm-btn').click());
    expect(onDelete).toHaveBeenCalledWith('session', false, undefined);
  });
  it.each([
    '3 uncommitted files will be discarded; branch b4m/test is kept',
    'Branch b4m/test is kept: 2 commits not pushed or merged',
  ])('defaults cleanup on for a discardable worktree and displays %s', async reason => {
    const { onDelete } = await mount({ ...safe, safe: false, reason });
    expect(checkbox().checked).toBe(true);
    expect(checkbox().disabled).toBe(false);
    expect(element('delete-session-worktree-note').textContent).toBe(reason);
    await act(async () => element('delete-session-confirm-btn').click());
    expect(onDelete).toHaveBeenCalledWith('session', true, undefined);
  });
  it.each(['Used by another conversation', 'Contains another worktree', 'Conversation is still running'])(
    'keeps unsafe worktrees and displays %s',
    async reason => {
      const { onDelete } = await mount({ ...safe, safe: false, removable: false, reason });
      expect(checkbox().checked).toBe(false);
      expect(checkbox().disabled).toBe(true);
      expect(document.body.textContent).toContain(reason);
      await act(async () => element('delete-session-confirm-btn').click());
      expect(onDelete).toHaveBeenCalledWith('session', false, undefined);
    }
  );
  it('offers only a single delete when nothing is nested', async () => {
    await mount(safe);
    expect(document.querySelector('[data-testid="delete-session-with-nested-btn"]')).toBeNull();
    expect(element('delete-session-confirm-btn').textContent).toBe('Delete');
  });
  it('deletes only the parent, leaving nested sessions to move up', async () => {
    const { onDelete } = await mount(safe, undefined, { nested: [{ id: 'child' }] });
    expect(element('delete-session-message').textContent).toContain('"Parent" has a nested session');
    expect(element('delete-session-confirm-btn').textContent).toBe('Delete this session');
    await act(async () => element('delete-session-confirm-btn').click());
    expect(onDelete).toHaveBeenCalledWith('session', true, undefined);
  });
  it('deletes the parent with every nested session', async () => {
    const { onDelete } = await mount(safe, undefined, { nested: [{ id: 'child' }, { id: 'grandchild' }] });
    expect(element('delete-session-message').textContent).toContain('has 2 nested sessions');
    expect(element('delete-session-with-nested-btn').textContent).toBe('Delete 3 sessions');
    await act(async () => element('delete-session-with-nested-btn').click());
    expect(onDelete).toHaveBeenCalledWith('session', true, ['child', 'grandchild']);
  });
  it('removes a checkout shared with nested sessions only when they are deleted too', async () => {
    const shared = { ...safe, safe: false, removable: false, reason: 'Used by another conversation' };
    const { onDelete, inspect } = await mount(shared, undefined, { nested: [{ id: 'child' }], withNested: safe });
    expect(inspect).toHaveBeenCalledWith('session', ['child']);
    expect(checkbox().checked).toBe(true);
    expect(element('delete-session-worktree-note').textContent).toContain('only when its nested sessions are deleted');
    await act(async () => element('delete-session-confirm-btn').click());
    expect(onDelete).toHaveBeenCalledWith('session', false, undefined);
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
