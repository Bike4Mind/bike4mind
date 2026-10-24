// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillSummary } from '@shared/skills';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomizeNavItem, CustomizeScreen } from './CustomizePanel';
import { forgetSkillGroupExpansion } from './skillGroups';
import { desktopTheme } from '../theme';

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

const market = vi.hoisted(() => ({
  imports: vi.fn(async () => ({ imports: [] as unknown[] })),
  openOnWeb: vi.fn(async () => true),
  readLocalSkill: vi.fn(async () => ({
    ok: true as const,
    fields: { name: 'chrome-browser', description: 'Use the browser extension', body: 'Go.' },
    dropped: [] as string[],
    extraFiles: [] as string[],
    extraFileCount: 0,
  })),
  pickUploadSource: vi.fn(async () => ({ ok: false as const, error: 'No SKILL.md in that folder.' })),
}));

(window as unknown as { b4m: unknown }).b4m = {
  mcp: {
    getServers: async () => ({ servers: [], secretsPersisted: true }),
    onChanged: () => () => {},
  },
  skillMarket: market,
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
        name: 'pdf',
        description: 'Read and write PDFs',
        source: 'global',
        filePath: '/home/.claude/skills/synced/bucket/pdf/SKILL.md',
      },
      {
        name: 'docx',
        description: 'Read and write Word files',
        source: 'global',
        filePath: '/home/.claude/skills/synced/bucket/docx/SKILL.md',
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
  act(() => root.render(<CssVarsProvider theme={desktopTheme}>{node}</CssVarsProvider>));
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
    forgetSkillGroupExpansion();
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
        name: 'pdf',
        description: 'Read and write PDFs',
        source: 'global',
        filePath: '/home/.claude/skills/synced/bucket/pdf/SKILL.md',
      },
      {
        name: 'docx',
        description: 'Read and write Word files',
        source: 'global',
        filePath: '/home/.claude/skills/synced/bucket/docx/SKILL.md',
      },
    ];
  });

  it('orders Skills, MCP and Plugins and selects Skills by default', () => {
    renderScreen();
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map(tab => tab.textContent)).toEqual(['Skills', 'MCP', 'Plugins']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('h1')?.textContent).toBe('Customize');
    expect(isVisible(byTestId('skills-settings'))).toBe(true);
    expect(isVisible(byTestId('customize-plugins-grid'))).toBe(false);
  });

  it('removes the extra tab-row border while retaining the selected tab', () => {
    renderScreen();
    const row = byTestId('customize-tab-row');
    expect(row).not.toBeNull();
    const style = getComputedStyle(row!);
    expect(['', 'none']).toContain(style.borderBottomStyle);
    const tab = byTestId('customize-skills-tab');
    expect(tab?.getAttribute('aria-selected')).toBe('true');
  });

  it('selects Plugins and shows exactly four unavailable, inert cards', () => {
    const onClose = vi.fn();
    const onOpenSkillMarket = vi.fn();
    renderNode(<CustomizeScreen onClose={onClose} onOpenSkillMarket={onOpenSkillMarket} />);
    const pluginsTab = byTestId('customize-plugins-tab')!;
    expect(pluginsTab.hasAttribute('disabled')).toBe(false);
    act(() => pluginsTab.click());
    expect(pluginsTab.getAttribute('aria-selected')).toBe('true');
    expect(isVisible(byTestId('customize-plugins-grid'))).toBe(true);
    expect(isVisible(byTestId('skills-settings'))).toBe(false);
    expect(isVisible(byTestId('mcp-settings'))).toBe(false);

    const cards = allByTestId('customize-plugin-card');
    expect(cards.map(card => card.getAttribute('aria-label'))).toEqual(['DataLake', 'QuestMaster', 'Tavern', 'Studio']);
    act(() => pluginsTab.focus());
    for (const card of cards) {
      expect(card.tagName).toBe('ARTICLE');
      expect(card.querySelector('h2')?.textContent).toBe(card.getAttribute('aria-label'));
      expect(getComputedStyle(card).borderTopStyle).toBe('dashed');
      const addButton = card.querySelector<HTMLButtonElement>('[data-testid="customize-plugin-add-btn"]')!;
      expect(addButton.disabled).toBe(true);
      expect(addButton.textContent?.trim()).toBe('+');
      expect(addButton.getAttribute('aria-label')).toBe(`Add ${card.getAttribute('aria-label')}`);
      expect(card.querySelectorAll('button')).toHaveLength(1);
      expect(card.querySelector('a, input, select, textarea, [tabindex="0"], [role="button"]')).toBeNull();
      const status = card.querySelector('[data-testid="customize-plugin-status"]')!;
      expect(status.querySelector('[aria-hidden="true"]')?.textContent).toBe('\uD83D\uDEA7');
      expect(status.lastChild?.textContent?.trim()).toBe('Under construction');
      const grid = byTestId('customize-plugins-grid')!;
      const onClick = vi.fn();
      grid.addEventListener('click', onClick, true);
      try {
        act(() => addButton.click());
        expect(onClick).not.toHaveBeenCalled();
      } finally {
        grid.removeEventListener('click', onClick, true);
      }
      act(() => {
        addButton.focus();
        card.click();
        card.focus();
        card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      });
      expect(document.activeElement).toBe(pluginsTab);
    }
    expect(onClose).not.toHaveBeenCalled();
    expect(onOpenSkillMarket).not.toHaveBeenCalled();
    expect(pluginsTab.getAttribute('aria-selected')).toBe('true');

    act(() => byTestId('customize-skills-tab')?.click());
    expect(isVisible(byTestId('skills-settings'))).toBe(true);
    expect(isVisible(byTestId('customize-plugins-grid'))).toBe(false);
  });

  it('keeps arrow-key navigation through all three enabled tabs', () => {
    renderScreen();
    const skillsTab = byTestId('customize-skills-tab')!;
    const mcpTab = byTestId('customize-mcp-tab')!;
    const pluginsTab = byTestId('customize-plugins-tab')!;
    act(() => skillsTab.focus());
    const arrow = (key: string) =>
      act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    arrow('ArrowRight');
    expect(document.activeElement).toBe(mcpTab);
    arrow('ArrowRight');
    expect(document.activeElement).toBe(pluginsTab);
    act(() => pluginsTab.click());
    expect(isVisible(byTestId('customize-plugins-grid'))).toBe(true);
    arrow('ArrowRight');
    expect(document.activeElement).toBe(skillsTab);
    arrow('ArrowLeft');
    expect(document.activeElement).toBe(pluginsTab);
  });

  it('groups global skills by their top-level ~/.claude/skills scope, a lone skill as a plain row', () => {
    renderScreen();
    expect(text(byTestId('user-skill-scopes'))).toContain('Your skills');
    const single = allByTestId('skills-single-row');
    expect(single.map(row => text(row))).toEqual([expect.stringContaining('/chrome-browser')]);
    expect(single[0]?.querySelector('[data-testid="skills-group-toggle-btn"]')).toBeNull();

    const groups = allByTestId('skill-group');
    expect(text(groups[0])).toContain('Bike4Mind skills');
    expect(text(groups[0])).toContain('No Bike4Mind account skills loaded.');
    expect(text(groups[1])).toContain('synced');
    expect(text(groups[1])).toContain('/pdf');
    expect(text(groups[1])).toContain('/docx');
    expect(text(container)).not.toContain('Project skills');
    expect(text(container)).not.toContain('/my-review');
    expect(text(container)).not.toContain('/legacy-command');
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

  it('lists account skills under Bike4Mind skills with a Bike4Mind chip, and not under Your skills', () => {
    skills.state.skills = [
      ...skills.state.skills,
      { name: 'web-summary', description: 'Summarise', source: 'account', filePath: 'b4m:/api/skills/a1' },
    ];
    renderScreen();
    const account = allByTestId('skill-group').find(group => text(group)?.includes('Bike4Mind skills'));
    expect(text(account)).toContain('/web-summary');
    expect(text(account)).not.toContain('No Bike4Mind account skills loaded.');
    expect(text(byTestId('user-skill-scopes'))).not.toContain('web-summary');

    const row = allByTestId('customize-skill-row').find(candidate => text(candidate)?.includes('/web-summary'));
    expect(text(row?.querySelector('[data-testid="customize-skill-chip"]'))).toBe('Bike4Mind');
  });

  it('marks a Skill Market import, offers its update, and opens the market and the web', async () => {
    skills.state.skills = [
      ...skills.state.skills,
      { name: 'web-summary', description: 'Mine', source: 'account', filePath: 'b4m:/api/skills/a1' },
      { name: 'market-pick', description: 'Theirs', source: 'account', imported: true, filePath: 'b4m:/api/skills/a2' },
    ];
    market.imports.mockResolvedValueOnce({
      imports: [{ skillId: 'a2', name: 'market-pick', listingId: 'l1', updateAvailable: true }],
    });
    const onOpenSkillMarket = vi.fn();
    renderNode(<CustomizeScreen sessionId="session-1" onClose={() => {}} onOpenSkillMarket={onOpenSkillMarket} />);
    await act(async () => {});

    const rows = allByTestId('customize-skill-row');
    const mine = rows.find(row => text(row)?.includes('/web-summary'));
    const theirs = rows.find(row => text(row)?.includes('/market-pick'));
    expect(mine?.querySelector('[data-testid="customize-skill-imported-chip"]')).toBeNull();
    expect(mine?.querySelector('[data-testid="customize-skill-update-btn"]')).toBeNull();
    expect(text(theirs?.querySelector('[data-testid="customize-skill-imported-chip"]'))).toBe('Imported');

    act(() => theirs?.querySelector<HTMLElement>('[data-testid="customize-skill-update-btn"]')?.click());
    expect(onOpenSkillMarket).toHaveBeenLastCalledWith({ id: 'l1' });
    act(() => byTestId('customize-skill-market-btn')?.click());
    expect(onOpenSkillMarket).toHaveBeenLastCalledWith();
    act(() => mine?.querySelector<HTMLElement>('[data-testid="customize-skill-web-btn"]')?.click());
    expect(market.openOnWeb).toHaveBeenCalledWith({ kind: 'skill', id: 'a1' });
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
  it('offers Upload on local rows only, resolved by name in main, and opens the preview', async () => {
    skills.state.skills = [
      ...skills.state.skills,
      { name: 'web-summary', description: 'Summarise', source: 'account', filePath: 'b4m:/api/skills/a1' },
    ];
    renderScreen();
    const rows = allByTestId('customize-skill-row');
    const account = rows.find(row => text(row)?.includes('/web-summary'));
    expect(account?.querySelector('[data-testid="skill-row-upload-btn"]')).toBeNull();

    const local = rows.find(row => text(row)?.includes('/chrome-browser'));
    await act(async () => local?.querySelector<HTMLElement>('[data-testid="skill-row-upload-btn"]')?.click());
    expect(market.readLocalSkill).toHaveBeenCalledWith({ sessionId: 'session-1', name: 'chrome-browser' });
    expect(document.querySelector('[data-testid="skill-upload-dialog"]')).not.toBeNull();
  });

  it('shows a failed pick inline', async () => {
    renderScreen();
    await act(async () => byTestId('skill-upload-pick-btn')?.click());
    expect(text(byTestId('skill-upload-pick-error'))).toContain('No SKILL.md in that folder.');
  });
});

describe('the Customize skill groups', () => {
  const skill = (scope: string, name: string, description = `About ${name}`): SkillSummary => ({
    name,
    description,
    source: 'global',
    filePath: `/home/.claude/skills/${scope}/${name}/SKILL.md`,
  });
  /** `count` groups of two skills each, so every one has a header. */
  const manyGroups = (count: number) =>
    Array.from({ length: count }, (_, index) => [
      skill(`group-${index}`, `alpha-${index}`),
      skill(`group-${index}`, `beta-${index}`),
    ]).flat();

  const toggles = () => allByTestId('skills-group-toggle-btn');
  const groupNamed = (title: string) => allByTestId('skill-group').find(group => text(group)?.includes(title));
  const rowsIn = (node: HTMLElement | undefined) =>
    [...(node?.querySelectorAll('[data-testid="customize-skill-row"]') ?? [])].map(row => text(row));
  const typeFilter = (value: string) => {
    const input = byTestId('skills-filter-input') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  beforeEach(() => {
    if (root) act(() => root.unmount());
    document.body.replaceChildren();
    forgetSkillGroupExpansion();
  });

  it('opens expanded when there are few groups, and a header toggles its rows', () => {
    skills.state.skills = manyGroups(3);
    renderScreen();
    expect(toggles().map(toggle => toggle.getAttribute('aria-expanded'))).toEqual(['true', 'true', 'true']);
    expect(toggles()[0]?.tagName).toBe('BUTTON');
    expect(rowsIn(groupNamed('group-0'))).toHaveLength(2);

    act(() => toggles()[0]?.click());
    expect(toggles()[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(rowsIn(groupNamed('group-0'))).toEqual([]);
    expect(groupNamed('group-0')?.querySelector('[data-testid="skills-group-list"]')).toBeNull();
    expect(rowsIn(groupNamed('group-1'))).toHaveLength(2);

    act(() => toggles()[0]?.click());
    expect(toggles()[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(rowsIn(groupNamed('group-0'))).toHaveLength(2);
  });

  it('opens collapsed above ten groups and renders no rows for collapsed groups', () => {
    skills.state.skills = manyGroups(11);
    renderScreen();
    expect(toggles()).toHaveLength(11);
    expect(toggles().every(toggle => toggle.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(allByTestId('customize-skill-row')).toEqual([]);
    expect(allByTestId('skills-group-list')).toEqual([]);
  });

  it('collapses and expands every group at once', () => {
    skills.state.skills = [
      ...manyGroups(3),
      { name: 'web-summary', description: 'Summarise', source: 'account', filePath: 'b4m:/api/skills/a1' },
    ];
    renderScreen();
    const all = () => byTestId('skills-collapse-all-btn');
    expect(text(all())).toBe('Collapse all');

    act(() => all()?.click());
    expect(toggles()).toHaveLength(4);
    expect(toggles().every(toggle => toggle.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(allByTestId('customize-skill-row')).toEqual([]);
    expect(text(all())).toBe('Expand all');

    act(() => all()?.click());
    expect(toggles().every(toggle => toggle.getAttribute('aria-expanded') === 'true')).toBe(true);
    expect(allByTestId('customize-skill-row')).toHaveLength(7);
  });

  it('shows only matches while filtering, expanding just the groups that have one', () => {
    skills.state.skills = [...manyGroups(11), skill('lonely', 'solo')];
    renderScreen();
    expect(allByTestId('customize-skill-row')).toHaveLength(1);

    typeFilter('BETA-3');
    expect(allByTestId('skill-group').map(group => text(group?.querySelector('button')))).toEqual([
      expect.stringContaining('group-3'),
    ]);
    expect(toggles()[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(rowsIn(groupNamed('group-3'))).toEqual([expect.stringContaining('/beta-3')]);
    expect(allByTestId('skills-single-row')).toEqual([]);

    typeFilter('nothing-matches-this');
    expect(text(byTestId('skills-filter-empty'))).toBe('No skills match.');
    expect(allByTestId('skill-group')).toEqual([]);

    typeFilter('');
    expect(toggles()).toHaveLength(11);
    expect(toggles().every(toggle => toggle.getAttribute('aria-expanded') === 'false')).toBe(true);
  });

  it('matches descriptions too', () => {
    skills.state.skills = [skill('docs', 'pdf', 'Read portable documents'), skill('docs', 'xlsx', 'Spreadsheets')];
    renderScreen();
    typeFilter('portable');
    expect(rowsIn(groupNamed('docs'))).toEqual([expect.stringContaining('/pdf')]);
  });

  it('remembers expanded groups when the screen is reopened', () => {
    skills.state.skills = manyGroups(11);
    renderScreen();
    act(() => toggles()[2]?.click());
    act(() => root.unmount());

    renderScreen();
    expect(toggles().map(toggle => toggle.getAttribute('aria-expanded'))).toEqual(
      Array.from({ length: 11 }, (_, index) => (index === 2 ? 'true' : 'false'))
    );
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
