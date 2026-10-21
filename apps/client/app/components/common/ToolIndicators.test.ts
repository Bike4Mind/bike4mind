import { describe, it, expect } from 'vitest';
import { hasToolIndicators } from './ToolIndicators';

const none = { activePrimaryTools: [], isThinkingActive: false, otherActiveToolsCount: 0, enabledMcpServers: [] };

describe('hasToolIndicators', () => {
  it('is false when nothing is on', () => {
    expect(hasToolIndicators(none)).toBe(false);
  });

  it('counts the primary tools that have an icon, and only those', () => {
    expect(hasToolIndicators({ ...none, activePrimaryTools: ['web_search'] })).toBe(true);
    expect(hasToolIndicators({ ...none, activePrimaryTools: ['dice_roll'] })).toBe(false);
  });

  it('counts thinking and the "+N" tools', () => {
    expect(hasToolIndicators({ ...none, isThinkingActive: true })).toBe(true);
    expect(hasToolIndicators({ ...none, otherActiveToolsCount: 2 })).toBe(true);
  });

  it('counts an iconed integration only when it is both available and enabled', () => {
    expect(hasToolIndicators({ ...none, enabledMcpServers: ['github'], availableMcpServers: ['github'] })).toBe(true);
    expect(hasToolIndicators({ ...none, enabledMcpServers: ['github'], availableMcpServers: [] })).toBe(false);
    // No enable-list means every available server is on.
    expect(hasToolIndicators({ ...none, enabledMcpServers: null, availableMcpServers: ['atlassian'] })).toBe(true);
  });
});
