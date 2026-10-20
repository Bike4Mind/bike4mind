// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PermissionsState } from '@shared/permissions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionsSettings, permissionsSummary } from './PermissionsSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = (query => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const state: PermissionsState = {
  shareClaudeCode: true,
  user: [
    { rule: 'Bash(gh pr view:*)', list: 'allow' },
    { rule: 'Bash(rm:*)', list: 'deny' },
  ],
  projects: [{ directory: '/work/project', rules: [{ rule: 'Bash(make:*)', list: 'allow' }] }],
  claudeCode: [
    {
      id: 'cc-user',
      label: 'Claude Code user',
      path: '~/.claude/settings.json',
      status: 'loaded',
      rules: [
        { rule: 'Bash(git status:*)', list: 'allow' },
        { rule: 'Task', list: 'allow', problem: 'no desktop tool for Task' },
      ],
      additionalDirectories: ['/elsewhere'],
    },
    {
      id: 'cc-project:/work/project',
      label: 'Claude Code project: /work/project',
      path: '/work/project/.claude/settings.json',
      status: 'loaded',
      note: 'This project is not trusted, so its allow rules are ignored; its ask and deny rules apply.',
      rules: [{ rule: 'Bash(curl:*)', list: 'allow' }],
      additionalDirectories: [],
    },
  ],
};

const markup = (value: PermissionsState | null) =>
  renderToStaticMarkup(
    <CssVarsProvider>
      <PermissionsSettings state={value} onState={() => {}} />
    </CssVarsProvider>
  );

describe('PermissionsSettings', () => {
  const html = markup(state);

  it('lists the desktop rules with controls to edit, move and remove each', () => {
    expect(html).toContain('Bash(gh pr view:*)');
    expect(html.match(/data-testid="permissions-rule-row"/g)).toHaveLength(2);
    expect(html.match(/data-testid="permissions-rule-edit-btn"/g)).toHaveLength(2);
    expect(html.match(/data-testid="permissions-rule-remove-btn"/g)).toHaveLength(2);
    expect(html.match(/data-testid="permissions-rule-list-select"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="permissions-add-input"');
    expect(html).toContain('data-testid="permissions-add-btn"');
    expect(html).toContain('data-testid="permissions-scope-select"');
  });

  it('shows each Claude Code file closed, with its badge, path, rule count and any note', () => {
    expect(html.match(/data-testid="permissions-source"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="permissions-source-badge"');
    expect(html).toContain('~/.claude/settings.json');
    expect(html).toContain('2 rules');
    expect(html).toContain('1 rule<');
    expect(html).not.toContain('data-testid="permissions-shared-rule"');
    expect(html).toContain('data-testid="permissions-source-note"');
  });

  it('shows the desktop rules open, with a count', () => {
    expect(html).toContain('data-testid="permissions-desktop-toggle-btn"');
    expect(html).toMatch(/data-testid="permissions-desktop-count"[^>]*>2 rules</);
  });
  it('offers the sharing toggle', () => {
    expect(html).toContain('data-testid="permissions-sharing-switch"');
  });

  it('summarises the rule counts', () => {
    expect(permissionsSummary(state)).toBe('3 desktop rules, 2 shared from Claude Code');
    expect(permissionsSummary({ ...state, shareClaudeCode: false })).toBe('3 desktop rules');
    expect(markup(null)).toContain('data-testid="permissions-loading"');
  });
});

describe('PermissionsSettings collapsing', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (window as unknown as { b4m: unknown }).b4m = { chat: { listRecentFolders: async () => [] } };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <CssVarsProvider>
          <PermissionsSettings state={state} onState={() => {}} />
        </CssVarsProvider>
      )
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const all = (testId: string) => host.querySelectorAll(`[data-testid="${testId}"]`);
  const click = (element: Element) => act(() => (element as HTMLElement).click());

  it('opens a Claude Code file read-only, dims an unmapped entry and offers copy only for mapped ones', () => {
    click(all('permissions-source-toggle-btn')[0]);
    expect(all('permissions-source-toggle-btn')[0].getAttribute('aria-expanded')).toBe('true');
    expect(all('permissions-shared-rule')).toHaveLength(2);
    expect(host.textContent).toContain('Bash(git status:*)');
    expect(host.querySelector('[data-unmapped="true"]')?.textContent).toContain('no desktop tool for Task');
    expect(all('permissions-copy-btn')).toHaveLength(1);
    expect(host.textContent).toContain('/elsewhere');
    // No edit or remove control on a shared rule: only the desktop rows have them.
    expect(all('permissions-rule-remove-btn')).toHaveLength(2);

    click(all('permissions-source-toggle-btn')[0]);
    expect(all('permissions-shared-rule')).toHaveLength(0);
  });

  it('hides the desktop rules but keeps the add row', () => {
    click(all('permissions-desktop-toggle-btn')[0]);
    expect(all('permissions-rule-row')).toHaveLength(0);
    expect(all('permissions-add-input')).toHaveLength(1);
    expect(all('permissions-desktop-count')[0].textContent).toBe('2 rules');
  });
});
