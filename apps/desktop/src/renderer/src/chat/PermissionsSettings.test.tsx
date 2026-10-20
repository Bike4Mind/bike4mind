import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PermissionsState } from '@shared/permissions';
import { describe, expect, it } from 'vitest';
import { PermissionsSettings, permissionsSummary } from './PermissionsSettings';

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

  it('shows Claude Code rules read-only, grouped by file with a badge and the path', () => {
    expect(html.match(/data-testid="permissions-source"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="permissions-source-badge"');
    expect(html).toContain('~/.claude/settings.json');
    expect(html).toContain('Bash(git status:*)');
    expect(html.match(/data-testid="permissions-shared-rule"/g)).toHaveLength(3);
    // No edit or remove control on a shared rule: only the desktop rows have them.
    expect(html.match(/data-testid="permissions-rule-remove-btn"/g)).toHaveLength(2);
  });

  it('dims an unmapped entry with its reason and offers no copy for it', () => {
    expect(html).toContain('data-unmapped="true"');
    expect(html).toContain('no desktop tool for Task');
    expect(html.match(/data-testid="permissions-copy-btn"/g)).toHaveLength(2);
  });

  it("says when an untrusted project's allows are ignored, and shows additional directories", () => {
    expect(html).toContain('data-testid="permissions-source-note"');
    expect(html).toContain('/elsewhere');
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
