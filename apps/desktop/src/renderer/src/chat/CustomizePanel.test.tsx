// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillSummary } from '@shared/skills';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomizeNavItem, CustomizeScreen } from './CustomizePanel';

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
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(byTestId('skills-settings')).toBeVisible();
  });

  it('groups global skills by their top-level ~/.claude/skills scope', () => {
    renderScreen();
    const groups = allByTestId('skill-group');
    expect(byTestId('user-skill-scopes')).toHaveTextContent('Your skills');
    expect(groups[0]).toHaveTextContent('chrome-browser');
    expect(groups[0]).toHaveTextContent('/chrome-browser');
    expect(groups[1]).toHaveTextContent('hyperframes');
    expect(groups[1]).toHaveTextContent('/hyperframes');
    expect(groups[1]).toHaveTextContent('/brief-format');
    expect(container).not.toHaveTextContent('Project skills');
    expect(container).not.toHaveTextContent('/my-review');
    expect(container).not.toHaveTextContent('/legacy-command');
    expect(groups[2]).toHaveTextContent('Bike4Mind skills');
    expect(groups[2]).toHaveTextContent('No Bike4Mind account skills loaded.');
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
    expect(container).not.toHaveTextContent('No skills found in ~/.claude/skills.');
    expect(container).toHaveTextContent('No Bike4Mind account skills loaded.');
  });

  it('switches to MCP and preserves its inline controls', () => {
    renderScreen();
    act(() => byTestId('customize-mcp-tab')?.click());
    expect(byTestId('customize-mcp-tab')).toHaveAttribute('aria-selected', 'true');
    expect(byTestId('mcp-settings')).toBeVisible();
    expect(byTestId('mcp-settings-add-btn')).toBeVisible();
    expect(byTestId('config-entry-btn')).not.toBeInTheDocument();
  });

  it('leaves app preferences, the server, and the updater to Settings', () => {
    renderScreen();
    expect(container.querySelector('[data-entry="appearance"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-entry="prompt-suggestions"]')).not.toBeInTheDocument();
    expect(byTestId('update-settings')).not.toBeInTheDocument();
    expect(byTestId('environment-select-btn')).not.toBeInTheDocument();
  });

  it('keeps a way out of the screen', () => {
    renderScreen();
    expect(byTestId('customize-close-btn')).toBeVisible();
  });
});

describe('the Customize nav row', () => {
  it('opens the screen and keeps its stable hook', () => {
    renderNode(<CustomizeNavItem onOpen={() => {}} />);
    expect(byTestId('chat-customize-btn')).toBeVisible();
  });

  it('shows no attention badge when nothing needs attention', () => {
    renderNode(<CustomizeNavItem onOpen={() => {}} />);
    expect(byTestId('customize-attention-chip')).not.toBeInTheDocument();
  });
});
