// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillSummary } from '@shared/skills';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomizeNavItem, CustomizeScreen } from './CustomizePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
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

(window as unknown as { b4m: unknown }).b4m = {
  mcp: {
    getServers: async () => ({ servers: [], secretsPersisted: true }),
    onChanged: () => () => {},
  },
};

const skills = vi.hoisted(() => ({
  state: {
    skills: [
      { name: 'my-review', description: 'Review my changes', source: 'project', filePath: '/repo/.claude/SKILL.md' },
      {
        name: 'chrome-browser',
        description: 'Use the browser extension',
        source: 'global',
        filePath: '/home/.claude/skills/chrome-browser/SKILL.md',
      },
      {
        name: 'legacy-command',
        description: 'A global command',
        source: 'global',
        filePath: '/home/.claude/commands/legacy-command.md',
      },
      {
        name: 'hyperframes',
        description: 'Create videos',
        source: 'global',
        filePath: '/home/.claude/skills/hyperframes/SKILL.md',
      },
      {
        name: 'brief-format',
        description: 'Defines the brief format',
        source: 'global',
        filePath: '/home/.claude/skills/hyperframes/references/brief-format.md',
      },
    ] as SkillSummary[],
    projectDirectory: '/repo',
    untrustedProject: null as string | null,
  },
}));

vi.mock('./useSkills', () => ({
  useSkills: () => ({ ...skills.state, refresh: vi.fn(), trustProject: vi.fn() }),
}));

let root: Root;
let container: HTMLDivElement;

const renderNode = (node: React.ReactNode) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<CssVarsProvider>{node}</CssVarsProvider>));
  return container;
};

const renderScreen = () => renderNode(<CustomizeScreen sessionId="session-1" onClose={() => {}} />);

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ');

const isVisible = (node: HTMLElement | null) => {
  if (!node?.isConnected) return false;
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    const { display, visibility, opacity } = getComputedStyle(el);
    if (el.hidden || display === 'none' || visibility === 'hidden' || visibility === 'collapse' || opacity === '0') {
      return false;
    }
  }
  return true;
};

describe('the Customize screen', () => {
  beforeEach(() => {
    if (root) act(() => root.unmount());
    document.body.replaceChildren();
    skills.state.skills = [
      { name: 'my-review', description: 'Review my changes', source: 'project', filePath: '/repo/.claude/SKILL.md' },
      {
        name: 'chrome-browser',
        description: 'Use the browser extension',
        source: 'global',
        filePath: '/home/.claude/skills/chrome-browser/SKILL.md',
      },
      {
        name: 'legacy-command',
        description: 'A global command',
        source: 'global',
        filePath: '/home/.claude/commands/legacy-command.md',
      },
      {
        name: 'hyperframes',
        description: 'Create videos',
        source: 'global',
        filePath: '/home/.claude/skills/hyperframes/SKILL.md',
      },
      {
        name: 'brief-format',
        description: 'Defines the brief format',
        source: 'global',
        filePath: '/home/.claude/skills/hyperframes/references/brief-format.md',
      },
    ];
  });

  it('orders Skills before MCP and selects Skills by default', () => {
    renderScreen();
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map(tab => tab.textContent)).toEqual(['Skills', 'MCP']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(isVisible(byTestId('skills-settings'))).toBe(true);
  });

  it('groups global skills by their top-level ~/.claude/skills scope', () => {
    renderScreen();
    const groups = allByTestId('skill-group');
    expect(text(byTestId('user-skill-scopes'))).toContain('Your skills');
    expect(text(groups[0])).toContain('chrome-browser');
    expect(text(groups[0])).toContain('/chrome-browser');
    expect(text(groups[1])).toContain('hyperframes');
    expect(text(groups[1])).toContain('/hyperframes');
    expect(text(groups[1])).toContain('/brief-format');
    expect(text(container)).not.toContain('Project skills');
    expect(text(container)).not.toContain('/my-review');
    expect(text(container)).not.toContain('/legacy-command');
    expect(text(groups[2])).toContain('Bike4Mind skills');
    expect(text(groups[2])).toContain('No Bike4Mind account skills loaded.');
  });

  it('shows an explicit empty state for either skill group', () => {
    skills.state.skills = [
      {
        name: 'chrome-browser',
        description: 'Use the browser extension',
        source: 'global',
        filePath: '/home/.claude/skills/chrome-browser/SKILL.md',
      },
    ];
    renderScreen();
    expect(text(container)).not.toContain('No skills found in ~/.claude/skills.');
    expect(text(container)).toContain('No Bike4Mind account skills loaded.');
  });

  it('switches to MCP and preserves its inline controls', () => {
    renderScreen();
    act(() => byTestId('customize-mcp-tab')?.click());
    expect(byTestId('customize-mcp-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(isVisible(byTestId('mcp-settings'))).toBe(true);
    expect(isVisible(byTestId('mcp-settings-add-btn'))).toBe(true);
    expect(byTestId('config-entry-btn')).toBeNull();
  });

  it('leaves app preferences, the server, and the updater to Settings', () => {
    renderScreen();
    expect(container.querySelector('[data-entry="appearance"]')).toBeNull();
    expect(container.querySelector('[data-entry="prompt-suggestions"]')).toBeNull();
    expect(byTestId('update-settings')).toBeNull();
    expect(byTestId('environment-select-btn')).toBeNull();
  });

  it('keeps a way out of the screen', () => {
    renderScreen();
    expect(isVisible(byTestId('customize-close-btn'))).toBe(true);
  });
});

describe('the Customize nav row', () => {
  it('opens the screen and keeps its stable hook', () => {
    renderNode(<CustomizeNavItem onOpen={() => {}} />);
    expect(isVisible(byTestId('chat-customize-btn'))).toBe(true);
  });

  it('shows no attention badge when nothing needs attention', () => {
    renderNode(<CustomizeNavItem onOpen={() => {}} />);
    expect(byTestId('customize-attention-chip')).toBeNull();
  });
});
