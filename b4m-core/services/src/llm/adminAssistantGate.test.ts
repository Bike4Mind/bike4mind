import { describe, it, expect } from 'vitest';
import { ADMIN_ASSISTANT_TOOL_NAMES, B4MLLMToolsList } from '@bike4mind/common';
import { resolveAdminAssistantTools } from './adminAssistantGate';
import { ADMIN_ASSISTANT_SYSTEM_PROMPT, withAdminAssistantPrompt } from './adminAssistantPrompt';

const allAdminTools: ReadonlySet<string> = new Set(ADMIN_ASSISTANT_TOOL_NAMES);

describe('resolveAdminAssistantTools', () => {
  it('enables available admin tools and navigate_view when the gate is open', () => {
    const plan = resolveAdminAssistantTools({
      surface: 'admin-assistant',
      sessionOwnerId: 'admin1',
      userId: 'admin1',
      isAdmin: true,
      availableToolNames: allAdminTools,
    });

    expect(plan.open).toBe(true);
    expect(plan.enable).toHaveLength(ADMIN_ASSISTANT_TOOL_NAMES.length + 1);
    expect(plan.enable).toEqual(expect.arrayContaining([...ADMIN_ASSISTANT_TOOL_NAMES, 'navigate_view']));
    // Allowlist: every built-in except navigate_view is denied, so a new built-in is withheld by default.
    expect(new Set(plan.deny)).toEqual(new Set(B4MLLMToolsList.filter(name => name !== 'navigate_view')));
    expect(plan.deny).toEqual(expect.arrayContaining(['web_search', 'web_fetch', 'save_content_to_data_lake']));
    expect(plan.deny).not.toContain('navigate_view');
    expect(plan.disableUserIntegrations).toBe(true);
  });

  it('denies contributed tool names the host supplies alongside the admin tools', () => {
    const plan = resolveAdminAssistantTools({
      surface: 'admin-assistant',
      sessionOwnerId: 'admin1',
      userId: 'admin1',
      isAdmin: true,
      availableToolNames: new Set([...ADMIN_ASSISTANT_TOOL_NAMES, 'contributed_alpha']),
    });

    expect(plan.deny).toContain('contributed_alpha');
    expect(plan.enable).not.toContain('contributed_alpha');
    for (const name of ADMIN_ASSISTANT_TOOL_NAMES) expect(plan.deny).not.toContain(name);
  });

  it('enables only admin tools whose definitions are available', () => {
    const plan = resolveAdminAssistantTools({
      surface: 'admin-assistant',
      sessionOwnerId: 'admin1',
      userId: 'admin1',
      isAdmin: true,
      availableToolNames: new Set(['admin_get_user']),
    });

    expect(plan.open).toBe(true);
    expect(plan.enable).toEqual(['admin_get_user', 'navigate_view']);
    expect(plan.deny).not.toContain('navigate_view');
  });

  it('denies every admin tool for a non-admin on the admin surface', () => {
    const plan = resolveAdminAssistantTools({
      surface: 'admin-assistant',
      sessionOwnerId: 'u1',
      userId: 'u1',
      isAdmin: false,
      availableToolNames: allAdminTools,
    });

    expect(plan.open).toBe(false);
    expect(plan.enable).toEqual([]);
    expect(plan.deny).toEqual([...ADMIN_ASSISTANT_TOOL_NAMES]);
  });

  it('denies every admin tool for an admin in a normal session', () => {
    const plan = resolveAdminAssistantTools({ surface: null, isAdmin: true, availableToolNames: allAdminTools });

    expect(plan.open).toBe(false);
    expect(plan.enable).toEqual([]);
    expect(plan.deny).toEqual([...ADMIN_ASSISTANT_TOOL_NAMES]);
  });

  it('denies every admin tool for an admin acting in a session someone else owns', () => {
    const plan = resolveAdminAssistantTools({
      surface: 'admin-assistant',
      sessionOwnerId: 'u1',
      userId: 'admin1',
      isAdmin: true,
      availableToolNames: allAdminTools,
    });

    expect(plan.open).toBe(false);
    expect(plan.enable).toEqual([]);
    expect(plan.deny).toEqual([...ADMIN_ASSISTANT_TOOL_NAMES]);
    expect(plan.disableUserIntegrations).toBe(false);
  });

  it('treats a missing isAdmin as closed', () => {
    const plan = resolveAdminAssistantTools({
      surface: 'admin-assistant',
      sessionOwnerId: 'admin1',
      userId: 'admin1',
      availableToolNames: allAdminTools,
    });

    expect(plan.open).toBe(false);
    expect(plan.enable).toEqual([]);
    expect(plan.deny).toEqual([...ADMIN_ASSISTANT_TOOL_NAMES]);
  });
});

describe('withAdminAssistantPrompt', () => {
  it('returns the session prompt by reference when closed', () => {
    const sessionPrompt = 'SESSION PROMPT';
    expect(withAdminAssistantPrompt(sessionPrompt, false)).toBe(sessionPrompt);
    expect(withAdminAssistantPrompt(undefined, false)).toBeUndefined();
  });

  it('prepends the admin prompt when open', () => {
    const result = withAdminAssistantPrompt('SESSION PROMPT', true);

    expect(result?.startsWith(ADMIN_ASSISTANT_SYSTEM_PROMPT)).toBe(true);
    expect(result).toBe(`${ADMIN_ASSISTANT_SYSTEM_PROMPT}\n\nSESSION PROMPT`);
  });

  it('returns the admin prompt alone when open with no session prompt', () => {
    expect(withAdminAssistantPrompt(undefined, true)).toBe(ADMIN_ASSISTANT_SYSTEM_PROMPT);
  });
});
