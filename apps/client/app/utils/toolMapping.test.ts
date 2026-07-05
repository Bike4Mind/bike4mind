import { describe, it, expect } from 'vitest';
import { AGENT_MODE_TOOL_IDS, isToolAvailableInAgentMode } from './toolMapping';

describe('AGENT_MODE_TOOL_IDS / isToolAvailableInAgentMode', () => {
  it('includes the web + storage-backed artifact tools the default agent profile allows', () => {
    expect(isToolAvailableInAgentMode('web_search')).toBe(true);
    expect(isToolAvailableInAgentMode('image_generation')).toBe(true);
    expect(isToolAvailableInAgentMode('excel_generation')).toBe(true);
  });

  it('includes the inline visualization artifact tools (recharts, mermaid)', () => {
    // These emit an <artifact> block and write nothing, so they are exposed in
    // agent mode. Regression guard for the bug where asking an agent for a chart
    // returned "no Recharts tool" instead of rendering.
    expect(isToolAvailableInAgentMode('recharts')).toBe(true);
    expect(isToolAvailableInAgentMode('mermaid_chart')).toBe(true);
  });

  it('maps the agent KB tool (retrieve_knowledge_content) onto the UI Knowledge Base toggle', () => {
    // The server allowlist carries `retrieve_knowledge_content`; the UI toggle is
    // `search_knowledge_base`. The alias keeps Knowledge Base from falsely
    // greying out in Agent mode.
    expect(AGENT_MODE_TOOL_IDS.has('search_knowledge_base')).toBe(true);
    expect(isToolAvailableInAgentMode('search_knowledge_base')).toBe(true);
    // The raw agent id is aliased away, not stored directly.
    expect(AGENT_MODE_TOOL_IDS.has('retrieve_knowledge_content')).toBe(false);
  });

  it('includes current_datetime — read-only, cache-safe clock exposed to agents', () => {
    // Agents need exact time-of-day on demand (e.g. to stamp an action at
    // execution instant) without a volatile minute-precision block polluting
    // the cached system prefix.
    expect(isToolAvailableInAgentMode('current_datetime')).toBe(true);
  });

  it('excludes Smart Tools the default agent profile does not allow', () => {
    expect(isToolAvailableInAgentMode('wolfram_alpha')).toBe(false);
    expect(isToolAvailableInAgentMode('web_fetch')).toBe(false);
    expect(isToolAvailableInAgentMode('weather_info')).toBe(false);
  });
});
