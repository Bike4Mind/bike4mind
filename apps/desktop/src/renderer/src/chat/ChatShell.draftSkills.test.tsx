// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import type { SkillsScope, SkillsState } from '@shared/skills';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { setWorktreeByDefault } from './worktreeDefault';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));

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

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const PROJECT = {
  directory: '/repo',
  name: 'repo',
  branch: 'main',
  workspace: false,
  workingDirectory: '/repo',
};

const FIRST: ChatSessionSummary = {
  id: 'code-1',
  title: 'First',
  mode: 'code',
  model: 'test-model',
  project: PROJECT,
  messageCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
} as ChatSessionSummary;

const MY_REVIEW = {
  name: 'my-review',
  description: 'Review the branch.',
  source: 'global',
  filePath: '/home/user/.claude/skills/my-review/SKILL.md',
} as const;
const MY_PLAN = { ...MY_REVIEW, name: 'my-plan', filePath: '/home/user/.claude/skills/my-plan/SKILL.md' };

const SECOND: ChatSessionSummary = { ...FIRST, id: 'code-2', title: 'Second' };
const FRESH: ChatSessionSummary = { ...FIRST, id: 'code-3', title: 'Fresh thread' };

function quietBridge(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get(target, name: string | symbol) {
      if (typeof name !== 'string') return undefined;
      if (name in target) return target[name];
      if (name.startsWith('on')) return () => () => undefined;
      return async () => [];
    },
  });
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let createCodeSession = vi.fn<(request?: unknown) => Promise<unknown>>();
let inspectProject = vi.fn<(directory: string) => Promise<unknown>>();
let created: ChatSessionSummary | null = null;
let supportsTools = true;
const setSessionOrchestrate = vi.fn();
const sendMessage = vi.fn();
const listSkills = vi.fn<(scope: SkillsScope) => Promise<SkillsState>>();

beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
  // Opens on a Code session, so the sidebar draws the project group and its "+".
  window.localStorage.setItem('b4m.chat.lastSession', JSON.stringify({ id: FIRST.id, mode: 'code' }));
  created = null;
  supportsTools = true;
  setSessionOrchestrate.mockReset().mockImplementation(async (id: string, on: boolean) => {
    if (!created || created.id !== id) return null;
    created = { ...created, orchestrate: on };
    return created;
  });
  sendMessage.mockReset().mockResolvedValue({ ok: true, messageId: 'first-message' });
  listSkills.mockReset().mockImplementation(async () => ({
    skills: [MY_REVIEW, MY_PLAN],
    projectDirectory: null,
    untrustedProject: null,
  }));
  createCodeSession = vi.fn(async () => {
    created = FRESH;
    return { ok: true, session: FRESH };
  });
  inspectProject = vi.fn(async () => ({
    directory: PROJECT.directory,
    name: PROJECT.name,
    isRepository: true,
    branches: ['main'],
    currentBranch: 'main',
  }));
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      chat: quietBridge({
        listSessions: async () => (created ? [FIRST, SECOND, created] : [FIRST, SECOND]),
        getSession: async (id: string) =>
          ({ ...(id === FRESH.id ? (created ?? FRESH) : FIRST), messages: [] }) as unknown as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [{ id: 'test-model', name: 'Test Model', supportsTools }] }),
        defaultsForNewSession: async () => ({ model: 'test-model', approvalMode: 'auto', reasoningEffort: 'default' }),
        setSessionOrchestrate,
        sendMessage,
        listSkills,
        // The bridge's `[]` default is truthy, so the changes bar would render it as a reading.
        workspaceChanges: async () => null,
        inspectProject,
        createCodeSession,
      }),
      sidebar: quietBridge({ getSections: async () => ({ sections: [], assignments: {} }) }),
      getAppInfo: async () => ({ homeDirectory: '/home/user' }),
    },
    {
      get(target, name: string | symbol) {
        if (typeof name !== 'string') return undefined;
        return name in target ? target[name as 'chat' | 'sidebar'] : quietBridge({});
      },
    }
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setWorktreeByDefault(false);
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const el = (testId: string) => {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ChatShell />
      </CssVarsProvider>
    );
  });
  await act(async () => undefined);
}

function type(text: string) {
  const element = el('chat-composer-input') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    element.focus();
    setter?.call(element, text);
    element.setSelectionRange(text.length, text.length);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const skillNames = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="skill-picker-option"]')].map(
    row => row.querySelector('.MuiTypography-title-sm')?.textContent
  );

async function clickNewInProject() {
  await act(async () => el('project-new-btn').click());
  await act(async () => undefined);
}

describe('skills in a Code draft before its first send', () => {
  it('lists global skills for "/" and scopes the read to the chosen folder', async () => {
    await mount();
    await clickNewInProject();
    expect(createCodeSession).not.toHaveBeenCalled();

    type('/my-');
    await act(async () => undefined);

    expect(listSkills).toHaveBeenCalledWith({ draftDirectory: PROJECT.directory });
    expect(skillNames()).toEqual(['/my-plan', '/my-review']);
    expect(document.querySelector('[data-testid="skill-picker-empty-text"]')).toBeNull();
  });

  it('says nothing matches, rather than none installed, for a filter with no hits', async () => {
    await mount();
    await clickNewInProject();

    type('/zzz');
    await act(async () => undefined);

    expect(skillNames()).toEqual([]);
    expect(el('skill-picker-no-match-text').textContent).toBe('No skills match /zzz.');
    expect(document.querySelector('[data-testid="skill-picker-empty-text"]')).toBeNull();
  });

  it('runs a skill picked in the draft as the first turn of the created session', async () => {
    await mount();
    await clickNewInProject();

    type('/my-rev');
    await act(async () => undefined);
    act(() => {
      document
        .querySelector('[data-testid="skill-picker-option"]')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect((el('chat-composer-input') as HTMLTextAreaElement).value).toBe('/my-review ');

    await act(async () => el('chat-send-btn').click());
    await act(async () => undefined);

    expect(createCodeSession).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: FRESH.id, text: '/my-review' })
    );
    expect(listSkills).toHaveBeenLastCalledWith({ sessionId: FRESH.id });
  });
});
