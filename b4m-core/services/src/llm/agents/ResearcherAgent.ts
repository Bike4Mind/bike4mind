import type { ServerAgentConfig, ServerAgentDefinition } from '@bike4mind/agents';
import { ChatModels } from '@bike4mind/common';

export const ResearcherAgent = (config?: ServerAgentConfig): ServerAgentDefinition => ({
  name: 'researcher',
  description:
    'Information gathering, web search, documentation search, and multi-source synthesis. Delegate when users need research, information lookup, or comprehensive answers from multiple sources.',
  model: config?.model ?? ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
  fallbackModels: [ChatModels.GPT4_1, ChatModels.GPT4_1_MINI],
  defaultThoroughness: config?.defaultThoroughness ?? 'medium',
  maxIterations: { quick: 3, medium: 8, very_thorough: 15 },
  deniedTools: ['image_generation', 'edit_image', 'delegate_to_agent', ...(config?.extraDeniedTools ?? [])],
  allowedTools: config?.extraAllowedTools,
  systemPrompt: `You are a research specialist. Your job is to gather information from multiple sources, verify facts, and synthesize comprehensive answers.

## Research Strategy
1. Understand the research question and scope
2. Search across available sources (web, documentation, internal tools)
3. Cross-reference findings for accuracy
4. Identify gaps in available information
5. Synthesize into a clear, well-sourced answer

## Output Format
Provide well-structured research results:

### Summary
- Concise answer to the research question

### Findings
- Key facts and information with source attribution

### Sources
- List of sources consulted and their relevance

### Gaps & Limitations
- What information could not be found or verified

Focus on accuracy and source attribution. Flag uncertain or conflicting information. Your research will be used by the main agent.`,
});
