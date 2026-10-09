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
      { name: 'commit', description: 'Create a commit', source: 'global', filePath: '/home/.bike4mind/commit.md' },
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
      { name: 'commit', description: 'Create a commit', source: 'global', filePath: '/home/.bike4mind/commit.md' },
    ];
  });

  it('orders Skills before MCP and selects Skills by default', () => {
    renderScreen();
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map(tab => tab.textContent)).toEqual(['Skills', 'MCP']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(byTestId('skills-settings')).toBeVisible();
  });

  it('groups custom and Bike4Mind skills using their source directory', () => {
    renderScreen();
    const groups = allByTestId('skill-group');
    expect(groups[0]).toHaveTextContent('Your custom skills');
    expect(groups[0]).toHaveTextContent('/my-review');
    expect(groups[1]).toHaveTextContent('Bike4Mind skills');
    expect(groups[1]).toHaveTextContent('/commit');
  });

  it('shows an explicit empty state for either skill group', () => {
    skills.state.skills = [
      { name: 'commit', description: 'Create a commit', source: 'global', filePath: '/home/.bike4mind/commit.md' },
    ];
    renderScreen();
    expect(container).toHaveTextContent('No custom skills found for this project.');
    expect(container).not.toHaveTextContent('No Bike4Mind skills found.');
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
