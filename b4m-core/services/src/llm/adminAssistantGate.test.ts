import { describe, it, expect } from 'vitest';
import { ADMIN_ASSISTANT_TOOL_NAMES } from '@bike4mind/common';
import { resolveAdminAssistantTools } from './adminAssistantGate';
import { ADMIN_ASSISTANT_SYSTEM_PROMPT, withAdminAssistantPrompt } from './adminAssistantPrompt';

const allAdminTools: ReadonlySet<string> = new Set(ADMIN_ASSISTANT_TOOL_NAMES);

describe('resolveAdminAssistantTools', () => {
  it('enables available admin tools and navigate_view when the gate is open', () => {
    const plan = resolveAdminAssistantTools({
      surface: 'admin-assistant',
      isAdmin: true,
      availableToolNames: allAdminTools,
    });

    expect(plan.open).toBe(true);
    expect(plan.enable).toHaveLength(ADMIN_ASSISTANT_TOOL_NAMES.length + 1);
    expect(plan.enable).toEqual(expect.arrayContaining([...ADMIN_ASSISTANT_TOOL_NAMES, 'navigate_view']));
    expect(plan.deny).toEqual([]);
  });

  it('enables only admin tools whose definitions are available', () => {
    const plan = resolveAdminAssistantTools({
      surface: 'admin-assistant',
      isAdmin: true,
      availableToolNames: new Set(['admin_get_user']),
    });

    expect(plan.open).toBe(true);
    expect(plan.enable).toEqual(['admin_get_user', 'navigate_view']);
    expect(plan.deny).toEqual([]);
  });

  it('denies every admin tool for a non-admin on the admin surface', () => {
    const plan = resolveAdminAssistantTools({
      surface: 'admin-assistant',
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

  it('treats a missing isAdmin as closed', () => {
    const plan = resolveAdminAssistantTools({ surface: 'admin-assistant', availableToolNames: allAdminTools });

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
