/**
 * Custom Agent Adapter
 * Converts IAgentDocument (custom user-created agent) to AgentPersona format
 * used by the Slack integration agent system.
 */

import { IAgentDocument } from '@bike4mind/common';
import { AgentPersona } from './agent-parser';

/**
 * Convert a custom IAgentDocument to AgentPersona format
 * This allows custom agents to be used interchangeably with built-in agents
 */
export function customAgentToPersona(agent: IAgentDocument): AgentPersona {
  return {
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt || buildSystemPromptFromPersonality(agent.personality),
    capabilities: agent.capabilities || ['all'],
    // Custom agents don't have preferredTools by default - they use all available tools
    preferredModel: agent.preferredModel,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
  };
}

/**
 * Build a system prompt from personality dimensions
 * Used as fallback when custom agent doesn't have an explicit systemPrompt
 */
function buildSystemPromptFromPersonality(personality: IAgentDocument['personality'] | undefined): string {
  if (!personality) {
    return 'You are a helpful AI assistant.';
  }

  const parts: string[] = [];

  if (personality.description) {
    parts.push(personality.description);
  }

  if (personality.majorMotivation) {
    parts.push(`Your core motivation: ${personality.majorMotivation}`);
  }

  if (personality.minorMotivation) {
    parts.push(`You also value: ${personality.minorMotivation}`);
  }

  if (personality.communicationPattern) {
    parts.push(`Communication style: ${personality.communicationPattern}`);
  }

  if (personality.problemSolvingApproach) {
    parts.push(`When solving problems: ${personality.problemSolvingApproach}`);
  }

  if (personality.personalMission) {
    parts.push(`Your mission: ${personality.personalMission}`);
  }

  if (personality.coreValues) {
    parts.push(`Core values: ${personality.coreValues}`);
  }

  if (personality.quirk) {
    parts.push(`Personality quirk: ${personality.quirk}`);
  }

  // Fallback when no personality dimensions are set
  if (parts.length === 0) {
    return 'You are a helpful AI assistant.';
  }

  return parts.join('\n\n');
}
