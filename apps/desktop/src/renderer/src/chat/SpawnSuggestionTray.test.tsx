// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSpawnSuggestion, SpawnSuggestionResult } from '@shared/chat';
import type { SpawnLocation } from '@shared/spawnLocation';
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
  attachImage: async () => {},
  attachFilePath: async () => {},
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
  onOpenSession: Mock<(sessionId: string) => void>;
}

function handlers(): Handlers {
  return {
    onStart: vi.fn<StartFn>(async () => ok(BASE)),
    onDismiss: vi.fn(async (_suggestionId: string) => ok(BASE)),
    onSend: vi.fn<(text: string) => void>(),
    onOpenSession: vi.fn<(sessionId: string) => void>(),
  };
}

function render(
  suggestions: ChatSpawnSuggestion[],
  on: Handlers,
  streaming = false,
  location: SpawnLocation = 'worktree'
): void {
  host ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <SpawnSuggestionTray
          suggestions={suggestions}
          onStart={on.onStart}
          onDismiss={on.onDismiss}
          onOpenSession={on.onOpenSession}
          location={location}
        />
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
    expect(primary().textContent).toBe('Start in new worktree');
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
    on.onStart.mockResolvedValueOnce({ ok: false, error: 'Too many started sessions are already running' });
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

  it('opens the menu from the keyboard with focus inside it, so a choice can be picked by key', async () => {
    const on = handlers();
    render([BASE], on);
    const caret = byTestId('spawn-suggestion-start-menu-btn');
    act(() => caret.focus());
    await act(async () => {
      caret.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const menu = inDocument('spawn-suggestion-start-menu');
    expect(menu?.contains(document.activeElement)).toBe(true);
    expect(caret.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement?.getAttribute('data-testid')).toBe('spawn-suggestion-choice-here-item');
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(primary().textContent).toBe('Run here');
    expect(on.onStart).not.toHaveBeenCalled();
  });

  it('takes its first choice from the Settings location', () => {
    render([BASE], handlers(), false, 'local');
    expect(primary().textContent).toBe('Start in this folder');
    expect(hasBranchField()).toBe(false);
  });

  it('falls back to the default rule for ask, and for a worktree outside a git repository', () => {
    render([BASE], handlers(), false, 'ask');
    expect(primary().textContent).toBe('Start in new worktree');

    act(() => root?.unmount());
    root = null;
    render([{ ...BASE, repository: false }], handlers(), false, 'worktree');
    expect(primary().textContent).toBe('Start in this folder');
  });

  it('forgets a choice an old card remembered, so it cannot override Settings', async () => {
    window.localStorage.setItem(SPAWN_CHOICE_STORAGE_KEY, 'local');
    render([BASE], handlers());
    expect(primary().textContent).toBe('Start in new worktree');
    expect(window.localStorage.getItem(SPAWN_CHOICE_STORAGE_KEY)).toBeNull();

    await choose('here');
    expect(window.localStorage.getItem(SPAWN_CHOICE_STORAGE_KEY)).toBeNull();
  });

  describe('a session the Settings location started with no card', () => {
    const autoStarted = (createdAt: string): ChatSpawnSuggestion => ({
      ...BASE,
      createdAt,
      status: 'started',
      started: {
        placement: 'worktree',
        sessionId: 'child-1',
        title: 'Tidy imports',
        branch: 'agent/tidy-imports-2',
        edited: false,
        auto: true,
      },
    });

    it('is announced with its branch, and Open goes to the new session', async () => {
      const on = handlers();
      render([autoStarted(new Date().toISOString())], on);
      expect(byTestId('spawn-suggestion-auto-notice').textContent).toContain('agent/tidy-imports-2');
      expect(host?.querySelector('[data-testid="spawn-suggestion-card"]')).toBeNull();

      await click('spawn-suggestion-auto-notice-open-btn');
      expect(on.onOpenSession).toHaveBeenCalledWith('child-1');
      expect(host?.querySelector('[data-testid="spawn-suggestion-auto-notice"]')).toBeNull();
    });

    it('hides on request', async () => {
      render([autoStarted(new Date().toISOString())], handlers());
      await click('spawn-suggestion-auto-notice-hide-btn');
      expect(host?.querySelector('[data-testid="spawn-suggestion-auto-notice"]')).toBeNull();
    });

    it('is not replayed when an old conversation is reopened', () => {
      render([autoStarted('2026-10-14T00:00:00.000Z')], handlers());
      expect(host?.querySelector('[data-testid="spawn-suggestion-auto-notice"]')).toBeNull();
    });

    it('is not shown for a start the user made from the card', () => {
      const fromCard = autoStarted(new Date().toISOString());
      if (fromCard.started?.placement === 'worktree') delete fromCard.started.auto;
      render([fromCard], handlers());
      expect(host?.querySelector('[data-testid="spawn-suggestion-auto-notice"]')).toBeNull();
    });
  });

  it('says why an automatic start did not happen, and still starts with one click', async () => {
    const on = handlers();
    render([{ ...BASE, autoStartError: 'The branch agent/tidy-imports already exists.' }], on);
    expect(byTestId('spawn-suggestion-auto-error').textContent).toContain('already exists');

    await click('spawn-suggestion-start-btn');
    expect(on.onStart).toHaveBeenCalledWith(expect.objectContaining({ placement: 'worktree' }));
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

  // canStart checks the prompt before it looks at the choice, so one choice covers all three.
  it('needs a prompt to start', async () => {
    render([BASE], handlers());
    await click('spawn-suggestion-expand-btn');
    type(byTestId<HTMLTextAreaElement>('spawn-suggestion-prompt-input'), '  ');
    expect(primary().disabled).toBe(true);
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
