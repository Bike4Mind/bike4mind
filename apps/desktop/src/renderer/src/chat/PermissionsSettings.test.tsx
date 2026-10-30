// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PermissionsState } from '@shared/permissions';
import type { CapabilityLedgerState } from '@shared/capabilities';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsSettings, permissionsSummary, usePermissions } from './PermissionsSettings';

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

const ledger: CapabilityLedgerState = {
  grants: [
    {
      id: 'g1',
      subject: { kind: 'session', sessionId: 'session-one' },
      capability: 'browser-origin',
      scope: { kind: 'browser-origin', value: 'https://example.com', access: 'act' },
      createdAt: '2026-01-01T00:00:00.000Z',
      source: 'approval',
    },
  ],
  audit: [
    {
      sequence: 0,
      type: 'grant',
      timestamp: '2026-01-01T00:00:00.000Z',
      grant: {
        id: 'g1',
        subject: { kind: 'session', sessionId: 'session-one' },
        capability: 'browser-origin',
        scope: { kind: 'browser-origin', value: 'https://example.com', access: 'act' },
        createdAt: '2026-01-01T00:00:00.000Z',
        source: 'approval',
      },
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

  it('shows grants and audit events and revokes from the active grant', async () => {
    const revoke = vi
      .fn()
      .mockResolvedValue({ ...ledger, grants: [{ ...ledger.grants[0], revokedAt: '2026-01-02T00:00:00.000Z' }] });
    (window as unknown as { b4m: unknown }).b4m = {
      chat: { listRecentFolders: async () => [] },
      permissions: { getState: async () => state },
      capabilities: { getState: async () => ledger, revoke },
    };
    await act(async () => {
      root.unmount();
      root = createRoot(host);
      root.render(
        <CssVarsProvider>
          <PermissionsSettings state={state} onState={() => {}} />
        </CssVarsProvider>
      );
    });
    expect(host.querySelectorAll('[data-testid="capability-grant-row"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="capability-audit-row"]')).toHaveLength(1);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="capability-revoke-btn"]')?.click();
    });
    expect(revoke).toHaveBeenCalledWith('g1');
    expect(host.querySelectorAll('[data-testid="capability-grant-row"]')).toHaveLength(0);
  });

  it('renders only the most recent 200 audit events', async () => {
    const audit = Array.from({ length: 250 }, (_, index) => ({
      sequence: 249 - index,
      type: 'revoke' as const,
      timestamp: '2026-01-01T00:00:00.000Z',
      grantId: `audit-${String(249 - index).padStart(3, '0')}`,
    }));
    (window as unknown as { b4m: unknown }).b4m = {
      chat: { listRecentFolders: async () => [] },
      capabilities: { getState: async () => ({ grants: [], audit }) },
    };
    await act(async () => {
      root.unmount();
      root = createRoot(host);
      root.render(
        <CssVarsProvider>
          <PermissionsSettings state={state} onState={() => {}} />
        </CssVarsProvider>
      );
    });
    const rows = host.querySelectorAll('[data-testid="capability-audit-row"]');
    expect(rows).toHaveLength(200);
    expect(rows[0].textContent).toContain('audit-24');
    expect(rows[199].textContent).toContain('audit-05');
    expect(host.textContent).toContain('200 recent audit events');
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

describe('PermissionsSettings mutation failures', () => {
  let host: HTMLDivElement;
  let root: Root;
  let setRules: ReturnType<typeof vi.fn>;
  const exportApprovalSummary = vi.fn();
  const onState = vi.fn();

  beforeEach(async () => {
    onState.mockReset();
    setRules = vi.fn();
    (window as unknown as { b4m: unknown }).b4m = {
      chat: { listRecentFolders: async () => [] },
      permissions: { setRules, exportApprovalSummary },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <CssVarsProvider>
          <PermissionsSettings state={state} onState={onState} />
        </CssVarsProvider>
      );
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('exports the approval summary and says where it stands', async () => {
    const button = () => host.querySelector<HTMLButtonElement>('[data-testid="permissions-export-summary-btn"]');
    const note = () => host.querySelector('[data-testid="permissions-export-summary-note"]')?.textContent;
    exportApprovalSummary.mockResolvedValueOnce(false);
    await act(async () => {
      button()?.click();
    });
    expect(note()).toContain('never full commands');
    exportApprovalSummary.mockResolvedValueOnce(true);
    await act(async () => {
      button()?.click();
    });
    expect(note()).toContain('Saved.');
    exportApprovalSummary.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => {
      button()?.click();
    });
    expect(note()).toBe('Could not save the summary.');
  });

  it('blocks replacement mutations until the first save finishes', async () => {
    let finish: ((value: { ok: true; state: PermissionsState }) => void) | undefined;
    setRules.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const remove = host.querySelectorAll<HTMLButtonElement>('[data-testid="permissions-rule-remove-btn"]');
    await act(async () => {
      remove[0].click();
    });
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
    await act(async () => {
      remove[1].click();
    });
    expect(setRules).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish?.({ ok: true, state });
    });
    expect(host.querySelector('fieldset')?.disabled).toBe(false);
  });

  it('shows rejected saves and enables retry without claiming success', async () => {
    setRules.mockRejectedValueOnce(new Error('disk full'));
    const remove = host.querySelector<HTMLButtonElement>('[data-testid="permissions-rule-remove-btn"]');
    await act(async () => {
      remove?.click();
    });
    expect(host.textContent).toContain('Could not save permission rules');
    expect(host.textContent).toContain('disk full');
    expect(onState).not.toHaveBeenCalled();
    expect(host.querySelector('fieldset')?.disabled).toBe(false);
    setRules.mockResolvedValueOnce({ ok: true, state });
    await act(async () => {
      remove?.click();
    });
    expect(onState).toHaveBeenCalledWith(state);
    expect(host.textContent).not.toContain('disk full');
  });

  it('keeps an edited rule available for correction after validation fails', async () => {
    setRules.mockResolvedValueOnce({ ok: false, error: 'not a rule' });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="permissions-rule-edit-btn"]')?.click();
    });
    const input = host.querySelector<HTMLInputElement>('[data-testid="permissions-rule-edit-input"]');
    if (!input) throw new Error('Edit input missing');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Bash(');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="permissions-rule-save-btn"]')?.click();
    });
    expect(host.textContent).toContain('not a rule');
    expect(host.querySelector<HTMLInputElement>('[data-testid="permissions-rule-edit-input"]')?.value).toBe('Bash(');
    expect(onState).not.toHaveBeenCalled();
  });

  it('shows load failures with a retry action', async () => {
    const retry = vi.fn();
    await act(async () => {
      root.render(
        <CssVarsProvider>
          <PermissionsSettings state={null} onState={onState} loadError="unreadable" onRetry={retry} />
        </CssVarsProvider>
      );
    });
    expect(host.textContent).toContain('Could not load permission rules: unreadable');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button')?.click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('usePermissions recovery', () => {
  it('retries a failed load instead of leaving settings loading forever', async () => {
    const getState = vi.fn().mockRejectedValueOnce(new Error('unreadable')).mockResolvedValueOnce(state);
    (window as unknown as { b4m: unknown }).b4m = {
      chat: { listRecentFolders: async () => [] },
      permissions: { getState },
    };
    function ConnectedSettings() {
      const [value, setValue, error, retry] = usePermissions();
      return <PermissionsSettings state={value} onState={setValue} loadError={error} onRetry={retry} />;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          <CssVarsProvider>
            <ConnectedSettings />
          </CssVarsProvider>
        );
      });
      expect(host.textContent).toContain('Could not load permission rules');
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button')?.click();
      });
      expect(getState).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain('Bash(gh pr view:*)');
      expect(host.textContent).not.toContain('Could not load permission rules');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});

describe('PermissionsSettings ledger synchronization', () => {
  let host: HTMLDivElement;
  let root: Root;
  const ruleLedger: CapabilityLedgerState = {
    ...ledger,
    grants: [
      {
        ...ledger.grants[0],
        subject: { kind: 'desktop-user' },
        capability: 'tool',
        scope: { kind: 'permission-rule', value: state.user[0].rule },
        source: 'permission-rule',
      },
    ],
  };
  const revokedLedger: CapabilityLedgerState = {
    ...ruleLedger,
    grants: [{ ...ruleLedger.grants[0], revokedAt: '2026-01-02T00:00:00.000Z' }],
  };

  function ConnectedSettings() {
    const [value, setValue, error, retry] = usePermissions();
    return <PermissionsSettings state={value} onState={setValue} loadError={error} onRetry={retry} />;
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = () =>
    act(async () => {
      root.render(
        <CssVarsProvider>
          <ConnectedSettings />
        </CssVarsProvider>
      );
    });

  it('refreshes permission rules after revoke so the next save cannot restore the revoked allow', async () => {
    const nextState = { ...state, user: state.user.slice(1) };
    const getState = vi.fn().mockResolvedValueOnce(state).mockResolvedValue(nextState);
    const setRules = vi.fn().mockResolvedValue({ ok: true, state: { ...nextState, user: [] } });
    (window as unknown as { b4m: unknown }).b4m = {
      chat: { listRecentFolders: async () => [] },
      permissions: { getState, setRules },
      capabilities: { getState: async () => ruleLedger, revoke: async () => revokedLedger },
    };
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="capability-revoke-btn"]')?.click());
    expect(host.querySelectorAll('[data-testid="permissions-rule-row"]')).toHaveLength(1);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="permissions-rule-remove-btn"]')?.click()
    );
    expect(setRules).toHaveBeenCalledWith({ kind: 'user' }, { allow: [], ask: [], deny: [] });
  });

  it('refreshes ledger grants after a permission rule save', async () => {
    const getLedger = vi.fn().mockResolvedValue(ruleLedger);
    (window as unknown as { b4m: unknown }).b4m = {
      chat: { listRecentFolders: async () => [] },
      permissions: {
        getState: async () => state,
        setRules: async () => ({ ok: true, state: { ...state, user: state.user.slice(1) } }),
      },
      capabilities: { getState: getLedger },
    };
    await render();
    expect(host.querySelectorAll('[data-testid="capability-grant-row"]')).toHaveLength(1);
    const callsBeforeSave = getLedger.mock.calls.length;
    getLedger.mockResolvedValue(revokedLedger);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="permissions-rule-remove-btn"]')?.click()
    );
    expect(getLedger.mock.calls.length).toBeGreaterThan(callsBeforeSave);
    expect(host.querySelectorAll('[data-testid="capability-grant-row"]')).toHaveLength(0);
  });

  it('blocks another revoke and rule edits while revocation is pending', async () => {
    let finish: ((value: CapabilityLedgerState) => void) | undefined;
    const revoke = vi.fn().mockImplementation(
      () =>
        new Promise<CapabilityLedgerState>(resolve => {
          finish = resolve;
        })
    );
    const setRules = vi.fn();
    (window as unknown as { b4m: unknown }).b4m = {
      chat: { listRecentFolders: async () => [] },
      permissions: { getState: async () => state, setRules },
      capabilities: { getState: async () => ruleLedger, revoke },
    };
    await render();
    const button = host.querySelector<HTMLButtonElement>('[data-testid="capability-revoke-btn"]');
    await act(async () => button?.click());
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="permissions-reload-btn"]')?.disabled).toBe(true);
    await act(async () => {
      button?.click();
      host.querySelector<HTMLButtonElement>('[data-testid="permissions-rule-remove-btn"]')?.click();
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(setRules).not.toHaveBeenCalled();
    await act(async () => finish?.(revokedLedger));
    expect(host.querySelector('fieldset')?.disabled).toBe(false);
  });

  it('locks stale rules after a successful revoke until a failed permissions refresh can be retried', async () => {
    const nextState = { ...state, user: state.user.slice(1) };
    const getState = vi
      .fn()
      .mockResolvedValueOnce(state)
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(nextState);
    const setRules = vi.fn();
    (window as unknown as { b4m: unknown }).b4m = {
      chat: { listRecentFolders: async () => [] },
      permissions: { getState, setRules },
      capabilities: { getState: async () => ruleLedger, revoke: async () => revokedLedger },
    };
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="capability-revoke-btn"]')?.click());
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
    expect(host.textContent).toContain('read failed');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="permissions-rule-remove-btn"]')?.click()
    );
    expect(setRules).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="permissions-reload-btn"]')?.click());
    expect(host.querySelector('fieldset')?.disabled).toBe(false);
    expect(host.querySelectorAll('[data-testid="permissions-rule-row"]')).toHaveLength(1);
  });

  it('reloads rules when revocation rejects after removing the underlying allow', async () => {
    const nextState = { ...state, user: state.user.slice(1) };
    const getState = vi.fn().mockResolvedValueOnce(state).mockResolvedValue(nextState);
    const setRules = vi.fn().mockResolvedValue({ ok: true, state: { ...nextState, user: [] } });
    const revoke = vi.fn().mockRejectedValue(new Error('audit write failed'));
    (window as unknown as { b4m: unknown }).b4m = {
      chat: { listRecentFolders: async () => [] },
      permissions: { getState, setRules },
      capabilities: { getState: async () => ruleLedger, revoke },
    };
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="capability-revoke-btn"]')?.click());
    expect(revoke).toHaveBeenCalledWith('g1');
    expect(getState).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Could not revoke capability: Error: audit write failed');
    expect(host.querySelectorAll('[data-testid="permissions-rule-row"]')).toHaveLength(1);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="permissions-rule-remove-btn"]')?.click()
    );
    expect(setRules).toHaveBeenCalledWith({ kind: 'user' }, { allow: [], ask: [], deny: [] });
  });

  it('keeps the panel but locks edits when both revocation and the rules refresh reject', async () => {
    const nextState = { ...state, user: state.user.slice(1) };
    const getState = vi
      .fn()
      .mockResolvedValueOnce(state)
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(nextState);
    const setRules = vi.fn();
    (window as unknown as { b4m: unknown }).b4m = {
      chat: { listRecentFolders: async () => [] },
      permissions: { getState, setRules },
      capabilities: {
        getState: async () => ruleLedger,
        revoke: async () => {
          throw new Error('audit write failed');
        },
      },
    };
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="capability-revoke-btn"]')?.click());
    expect(host.textContent).toContain('Could not reload permission rules: Error: read failed');
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="permissions-stale-banner"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="capability-grant-row"]')).toHaveLength(1);
    expect(setRules).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="permissions-reload-btn"]')?.click());
    expect(host.querySelectorAll('[data-testid="permissions-rule-row"]')).toHaveLength(1);
    expect(host.querySelector('fieldset')?.disabled).toBe(false);
  });
});
