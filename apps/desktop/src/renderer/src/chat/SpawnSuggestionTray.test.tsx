// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSpawnSuggestion, SpawnSuggestionResult } from '@shared/chat';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { desktopTheme } from '../theme';
import { Composer } from './Composer';
import { SPAWN_CHOICE_STORAGE_KEY, SpawnSuggestionTray } from './SpawnSuggestionTray';
import { writeDraft } from './spawnSuggestionDraft';
import type { AttachmentDraft } from './useAttachments';

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

const BASE: ChatSpawnSuggestion = {
  id: 's1',
  title: 'Tidy imports',
  prompt: 'remove the unused imports',
  summary: 'Clean up src/a.ts',
  base: 'feat/parent',
  branch: 'agent/tidy-imports',
  status: 'pending',
  revision: 0,
  createdAt: '2026-10-14T00:00:00.000Z',
};

const draft: AttachmentDraft = {
  attachments: [],
  busy: false,
  rejected: [],
  dismissRejected: () => {},
  add: async () => {},
  pick: async () => {},
  remove: () => {},
  clear: () => {},
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  writeDraft(BASE.id, undefined);
  window.localStorage.clear();
});

const ok = (suggestion: ChatSpawnSuggestion): SpawnSuggestionResult => ({ ok: true, suggestion });

type StartFn = Parameters<typeof SpawnSuggestionTray>[0]['onStart'];

interface Handlers {
  onStart: Mock<StartFn>;
  onDismiss: Mock<(suggestionId: string) => Promise<SpawnSuggestionResult>>;
  onSend: Mock<(text: string) => void>;
}

function handlers(): Handlers {
  return {
    onStart: vi.fn<StartFn>(async () => ok(BASE)),
    onDismiss: vi.fn(async (_suggestionId: string) => ok(BASE)),
    onSend: vi.fn<(text: string) => void>(),
  };
}

function render(suggestions: ChatSpawnSuggestion[], on: Handlers, streaming = false): void {
  host ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <SpawnSuggestionTray suggestions={suggestions} onStart={on.onStart} onDismiss={on.onDismiss} />
        <Composer
          sessionId="s1"
          disabled={false}
          streaming={streaming}
          attachments={draft}
          onSend={on.onSend}
          onStop={() => {}}
        />
      </CssVarsProvider>
    );
  });
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = host?.querySelector(`[data-testid="${id}"]`);
  if (!element) throw new Error(`no ${id}`);
  return element as T;
}

function type(element: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(id: string): Promise<void> {
  await act(async () => {
    byTestId(id).click();
  });
}

/** The menu is portalled out of the card, so it is looked up in the whole document. */
function inDocument(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

async function choose(choice: 'worktree' | 'local' | 'here'): Promise<void> {
  await click('spawn-suggestion-start-menu-btn');
  const item = inDocument(`spawn-suggestion-choice-${choice}-item`);
  if (!item) throw new Error(`no ${choice} item`);
  await act(async () => {
    item.click();
  });
}

const primary = () => byTestId<HTMLButtonElement>('spawn-suggestion-start-btn');
const hasBranchField = () => host?.querySelector('[data-testid="spawn-suggestion-branch-input"]') !== null;

describe('SpawnSuggestionTray', () => {
  it('shows the title, summary, branch and base, with the prompt folded away', () => {
    render([BASE], handlers());
    expect(byTestId('spawn-suggestion-title').textContent).toBe('Tidy imports');
    expect(byTestId('spawn-suggestion-summary').textContent).toBe('Clean up src/a.ts');
    expect(byTestId<HTMLInputElement>('spawn-suggestion-branch-input').value).toBe('agent/tidy-imports');
    expect(byTestId('spawn-suggestion-base').textContent).toBe('Based on feat/parent');
    expect(host?.querySelector('[data-testid="spawn-suggestion-prompt-input"]')).toBeNull();
  });

  it('starts with the edited prompt, title and branch', async () => {
    const on = handlers();
    render([BASE], on);
    await click('spawn-suggestion-expand-btn');
    type(byTestId<HTMLTextAreaElement>('spawn-suggestion-prompt-input'), 'remove and sort the imports');
    type(byTestId<HTMLInputElement>('spawn-suggestion-title-input'), 'Sort imports');
    type(byTestId<HTMLInputElement>('spawn-suggestion-branch-input'), 'agent/sort-imports');

    await click('spawn-suggestion-start-btn');
    expect(on.onStart).toHaveBeenCalledWith({
      suggestionId: 's1',
      placement: 'worktree',
      prompt: 'remove and sort the imports',
      title: 'Sort imports',
      branch: 'agent/sort-imports',
    });
  });

  it('starts in this folder without a branch, and shows a refusal on the card', async () => {
    const on = handlers();
    on.onStart.mockResolvedValueOnce({ ok: false, error: '3 started sessions are already running' });
    render([BASE], on);

    await choose('local');
    await click('spawn-suggestion-start-btn');
    expect(on.onStart).toHaveBeenCalledWith({
      suggestionId: 's1',
      placement: 'local',
      prompt: BASE.prompt,
      title: BASE.title,
    });
    expect(byTestId('spawn-suggestion-error').textContent).toContain('already running');
  });

  it('defaults to a new worktree in a git repository, showing the branch', () => {
    render([BASE], handlers());
    expect(primary().textContent).toBe('Start in new worktree');
    expect(hasBranchField()).toBe(true);
  });

  it('defaults to this folder outside a git repository, where a worktree cannot be chosen', async () => {
    render([{ ...BASE, repository: false }], handlers());
    expect(primary().textContent).toBe('Start in this folder');
    expect(hasBranchField()).toBe(false);

    await click('spawn-suggestion-start-menu-btn');
    expect(inDocument('spawn-suggestion-start-menu')).not.toBeNull();
    expect(inDocument('spawn-suggestion-choice-worktree-item')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('switches the primary action from the menu without starting anything', async () => {
    const on = handlers();
    render([BASE], on);

    await choose('here');
    expect(primary().textContent).toBe('Run here');
    expect(hasBranchField()).toBe(false);
    expect(host?.querySelector('[data-testid="spawn-suggestion-base"]')).toBeNull();

    await choose('local');
    expect(primary().textContent).toBe('Start in this folder');
    expect(hasBranchField()).toBe(false);

    await choose('worktree');
    expect(primary().textContent).toBe('Start in new worktree');
    expect(hasBranchField()).toBe(true);
    expect(on.onStart).not.toHaveBeenCalled();
  });

  it('labels each menu item with a line saying what it does', async () => {
    render([BASE], handlers());
    await click('spawn-suggestion-start-menu-btn');
    expect(inDocument('spawn-suggestion-choice-worktree-item')?.textContent).toContain('New session in a worktree');
    expect(inDocument('spawn-suggestion-choice-local-item')?.textContent).toContain('New session in this folder');
    const here = inDocument('spawn-suggestion-choice-here-item')?.textContent ?? '';
    expect(here).toContain('Run here, in this conversation');
    expect(here).toContain('No new session.');
    expect(byTestId('spawn-suggestion-start-menu-btn').getAttribute('aria-expanded')).toBe('true');
  });

  it('remembers the last choice for the next card', async () => {
    render([BASE], handlers());
    await choose('here');
    expect(window.localStorage.getItem(SPAWN_CHOICE_STORAGE_KEY)).toBe('here');

    act(() => root?.unmount());
    root = null;
    render([{ ...BASE, id: 's9' }], handlers());
    expect(primary().textContent).toBe('Run here');
  });

  it('ignores a remembered worktree choice outside a git repository, and an unknown value', () => {
    window.localStorage.setItem(SPAWN_CHOICE_STORAGE_KEY, 'worktree');
    render([{ ...BASE, repository: false }], handlers());
    expect(primary().textContent).toBe('Start in this folder');

    act(() => root?.unmount());
    root = null;
    window.localStorage.setItem(SPAWN_CHOICE_STORAGE_KEY, 'elsewhere');
    render([BASE], handlers());
    expect(primary().textContent).toBe('Start in new worktree');
  });

  it('runs here with the edited prompt and no branch, even with the branch cleared', async () => {
    const on = handlers();
    render([BASE], on);
    type(byTestId<HTMLInputElement>('spawn-suggestion-branch-input'), '');
    expect(primary().disabled).toBe(true);

    await choose('here');
    await click('spawn-suggestion-expand-btn');
    type(byTestId<HTMLTextAreaElement>('spawn-suggestion-prompt-input'), 'do it in this conversation');
    expect(primary().disabled).toBe(false);
    await click('spawn-suggestion-start-btn');
    expect(on.onStart).toHaveBeenCalledWith({
      suggestionId: 's1',
      placement: 'here',
      prompt: 'do it in this conversation',
      title: BASE.title,
    });
  });

  it('needs a prompt for every choice', async () => {
    render([BASE], handlers());
    await click('spawn-suggestion-expand-btn');
    type(byTestId<HTMLTextAreaElement>('spawn-suggestion-prompt-input'), '  ');
    for (const choice of ['worktree', 'local', 'here'] as const) {
      await choose(choice);
      expect(primary().disabled).toBe(true);
    }
  });

  it('dismisses', async () => {
    const on = handlers();
    render([BASE], on);
    await click('spawn-suggestion-dismiss-btn');
    expect(on.onDismiss).toHaveBeenCalledWith('s1');
    expect(on.onStart).not.toHaveBeenCalled();
  });

  it('takes an assistant update into a field the user has not touched, and flashes', async () => {
    render([BASE], handlers());
    await click('spawn-suggestion-expand-btn');
    render([{ ...BASE, prompt: 'remove and sort the imports', revision: 1 }], handlers());

    expect(byTestId<HTMLTextAreaElement>('spawn-suggestion-prompt-input').value).toBe('remove and sort the imports');
    expect(byTestId('spawn-suggestion-card').dataset.highlight).toBe('true');
    expect(host?.querySelector('[data-testid="spawn-suggestion-conflict-prompt"]')).toBeNull();
  });

  it('keeps the user text when the assistant updates a field they edited, and asks', async () => {
    render([BASE], handlers());
    await click('spawn-suggestion-expand-btn');
    type(byTestId<HTMLTextAreaElement>('spawn-suggestion-prompt-input'), 'my own version');
    render([{ ...BASE, prompt: 'the assistant version', revision: 1 }], handlers());

    const prompt = () => byTestId<HTMLTextAreaElement>('spawn-suggestion-prompt-input').value;
    expect(prompt()).toBe('my own version');
    expect(byTestId('spawn-suggestion-conflict-prompt').textContent).toContain('updated by the assistant - apply?');

    await click('spawn-suggestion-apply-prompt-btn');
    expect(prompt()).toBe('the assistant version');
    expect(host?.querySelector('[data-testid="spawn-suggestion-conflict-prompt"]')).toBeNull();
  });

  it('stops asking once the user keeps their version', async () => {
    render([BASE], handlers());
    await click('spawn-suggestion-expand-btn');
    type(byTestId<HTMLTextAreaElement>('spawn-suggestion-prompt-input'), 'my own version');
    render([{ ...BASE, prompt: 'the assistant version', revision: 1 }], handlers());

    await click('spawn-suggestion-keep-prompt-btn');
    expect(byTestId<HTMLTextAreaElement>('spawn-suggestion-prompt-input').value).toBe('my own version');
    expect(host?.querySelector('[data-testid="spawn-suggestion-conflict-prompt"]')).toBeNull();
  });

  it('draws only pending suggestions, so a started one leaves the tray', () => {
    const started: ChatSpawnSuggestion = {
      ...BASE,
      id: 's2',
      status: 'started',
      started: { sessionId: 'child-1', title: 'Tidy imports', placement: 'worktree', branch: 'agent/x', edited: false },
    };
    const ranHere: ChatSpawnSuggestion = {
      ...BASE,
      id: 's4',
      status: 'started',
      started: { title: 'Tidy imports', placement: 'here', edited: false },
    };
    render([BASE, started, ranHere, { ...BASE, id: 's3', status: 'dismissed' }], handlers());
    expect(host?.querySelectorAll('[data-testid="spawn-suggestion-card"]')).toHaveLength(1);

    render([started], handlers());
    expect(host?.querySelector('[data-testid="spawn-suggestion-tray"]')).toBeNull();
  });

  it('leaves the composer sending while a card is pending and a reply is running', () => {
    const on = handlers();
    render([BASE, { ...BASE, id: 's2', title: 'Second task' }], on, true);
    expect(host?.querySelectorAll('[data-testid="spawn-suggestion-card"]')).toHaveLength(2);

    const input = byTestId<HTMLTextAreaElement>('chat-composer-input');
    expect(input.disabled).toBe(false);
    type(input, 'also make it sort them');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(on.onSend).toHaveBeenCalledWith('also make it sort them');
  });
});
