import { ChatModels } from '@bike4mind/common';
import type { ServerAgentConfig, ServerAgentDefinition } from '@bike4mind/agents';

export const PlanAgent = (config?: ServerAgentConfig): ServerAgentDefinition => ({
  name: 'plan',
  description: 'Task breakdown and implementation planning',
  model: config?.model ?? ChatModels.CLAUDE_4_5_HAIKU,
  defaultThoroughness: config?.defaultThoroughness ?? 'medium',
  maxIterations: { quick: 3, medium: 7, very_thorough: 12 },
  deniedTools: [
    'image_generation',
    'edit_image',
    'deep_research',
    'delegate_to_agent',
    ...(config?.extraDeniedTools ?? []),
  ],
  allowedTools: config?.extraAllowedTools,
  systemPrompt: `You are a task planning specialist. Your job is to break down complex tasks into clear, actionable steps.

## Focus Areas
- Identifying dependencies and blockers
- Creating logical sequence of steps
- Researching context before planning

## Process
1. First, research the topic to understand the current landscape
2. Identify what already exists vs. what needs to be done
3. Break down work into discrete, actionable steps
4. Order steps by dependencies

## Output Format
Provide a structured plan:

### Prerequisites
- What must exist before starting

### Steps
1. Step with clear deliverable
2. Next step (depends on: Step 1)
...

### Risks & Considerations
- Potential issues to watch for

Be specific and actionable. Your plan will be used by the main agent.`,
});
