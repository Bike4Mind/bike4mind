import { describe, it, expect } from 'vitest';
import { ProjectManagerAgent } from './ProjectManagerAgent';

describe('ProjectManagerAgent', () => {
  it('does not assert unconditional tool possession (which forces fabrication)', () => {
    const prompt = ProjectManagerAgent().systemPrompt;
    expect(prompt).not.toContain('you DO have these tools');
  });

  it('instructs honest refusal when a tool is unavailable', () => {
    const prompt = ProjectManagerAgent().systemPrompt.toLowerCase();
    expect(prompt).toContain('never fabricate');
  });

  it('still claims atlassian as an exclusive MCP server', () => {
    expect(ProjectManagerAgent().exclusiveMcpServers).toEqual(['atlassian']);
  });

  it('allows the atlassian__* tool namespace (must stay in sync with exclusiveMcpServers)', () => {
    // exclusiveMcpServers routes atlassian tools to this agent; allowedTools is what actually
    // admits them into its toolset. If these drift, the agent spawns with 0 usable tools.
    expect(ProjectManagerAgent().allowedTools).toContain('atlassian__*');
  });
});
